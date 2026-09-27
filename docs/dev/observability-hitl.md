# Action Center + HITL observability dashboard

**Status**: Phase 7C of Plan 156. Metrics + recorders shipped 2026-05-24.

Three OpenTelemetry instruments cover the HITL surface today. They share a labelling vocabulary so a single dashboard can pivot across them without joining; the recorders live in [`packages/observability/src/metrics.ts`](../../packages/observability/src/metrics.ts) and emit from the Action Center aggregator + the Coach proposal resolution path.

## Instruments

| Metric                                        | Type           | Where emitted                                                                                                                      | Labels                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aflow.hitl.gate_latency_ms`                  | Histogram (ms) | `packages/server-runtime/src/services/actionCenter/aggregator.ts` — every successful resolve                                       | `tenant_id`, `space_id`, `origin_kind` (`step` / `proposal` / `gate` / `settings`), `item_kind` (`human_input` / `human_approval` / `ratification` / `platform_issue`), `gate_reason` (only when `origin_kind = 'gate'`), `operation_id`, `resolution_kind` (`approve` / `reject` / `submit` / `ratify` / `dismiss`) |
| `aflow.action_center.resolved_total`          | Counter        | Same call site                                                                                                                     | Same labels                                                                                                                                                                                                                                                                                                          |
| `aflow.coach.ratification_apply_errors_total` | Counter        | `packages/server-runtime/src/services/cybernetic/proposalResolution.ts` — on `RatificationApplyError` and on generic apply failure | `tenant_id`, `space_id`, `error_code`                                                                                                                                                                                                                                                                                |

**Latency definition**: `recordHitlGateLatency` measures `now - item.requestedAt` — i.e. **operator time-to-resolve from the moment the item appeared in the inbox**. Same value the persistent `hitl_action_audit.latencyMs` row stores, so the histogram is the live-streaming view of that column.

**No open-items gauge today.** The natural insert hook (decrement on resolve, increment on insert) lives on the Action Center projection write path, which is part of Plan 161's scope. Until that lands, `aflow.action_center.resolved_total` + `aflow.hitl.gate_latency_ms_count` together bound the backlog without a separate gauge — useful enough for the operational signals operators actually need (clear-rate, slow-resolves).

## Suggested dashboard panels (PromQL)

The OTLP exporter writes to whatever the platform's `OTEL_EXPORTER_OTLP_ENDPOINT` is wired to — Grafana / Prometheus is the typical target. Queries below assume Prometheus-style histograms (`*_bucket`, `*_count`, `*_sum`).

### 1. Resolve rate (clear-rate proxy)

```promql
sum by (item_kind) (
  rate(aflow_action_center_resolved_total[5m])
)
```

Stack by `item_kind` to spot which surface is busy (Coach ratifications vs paused-step gates vs egress).

### 2. Time-to-resolve p50 / p95 / p99

```promql
histogram_quantile(0.95,
  sum by (le, item_kind) (
    rate(aflow_hitl_gate_latency_ms_bucket[5m])
  )
)
```

The high-percentile band is the operator-experience SLI. A rising p95 with flat resolve-rate ≈ operators are answering at the same pace but Helmsman is producing slower-to-answer items (richer schemas, or items that need cross-team coordination).

### 3. Resolve rate by `gate_reason`

```promql
sum by (gate_reason) (
  rate(aflow_action_center_resolved_total{origin_kind="gate"}[15m])
)
```

Gate items only. Helps identify "the Stripe binding is firing 20× more gates than anything else" → bindings policy needs revisiting.

### 4. Coach ratification failures

```promql
sum by (error_code) (
  rate(aflow_coach_ratification_apply_errors_total[15m])
)
```

A flat-zero line is the healthy state. Any non-zero bucket points at a schema drift between what the Coach authored and what the apply path accepts — almost always actionable.

### 5. Approve vs reject ratio

```promql
sum by (resolution_kind) (
  rate(aflow_action_center_resolved_total{item_kind=~"human_approval|ratification"}[1h])
)
```

A rejection spike on a previously-stable surface is the canonical "Coach started authoring bad proposals" or "binding policy got too aggressive" tell.

## Suggested alerts

| Alert                        | Condition                                                                                              | Severity |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ | -------- |
| Coach apply-error spike      | `rate(aflow_coach_ratification_apply_errors_total[5m]) > 0` for 10 min                                 | warn     |
| HITL p95 latency degradation | `histogram_quantile(0.95, ...) > 30m` for 30 min                                                       | warn     |
| Resolve-rate stalled         | `rate(aflow_action_center_resolved_total[15m]) == 0` AND a backlog known via `hitl_action_audit` count | info     |

These are heuristic floors — tune against historical baselines once a real fleet is running. The relevant playbooks for the first two land here: the apply-error path is documented in Plan 138 §5.6, the latency story is part of Plan 156 §5.5.

## Adding new instruments

Hot-path emission: counters/histograms are ~100–200ns and safe to call inline. Initialization is gated by `initMetrics()` which is called at server startup; calling a recorder before init is a no-op (the module-level `?.` guards). Don't add new labels to existing metrics in this dashboard without checking cardinality — `gate_reason` is bounded; `operation_id` is bounded by the catalog; the others are tenant/space dimensions that explode if a tenant onboards thousands of spaces.
