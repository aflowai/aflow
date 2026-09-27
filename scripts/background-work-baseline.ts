/**
 * Measure the datastore cost of background work over a window.
 *
 * The plan's central claim — idle cost must scale with live process count, not
 * with shards, tenants, keys, or subscribers — is only checkable against a
 * recorded baseline. This samples Redis `INFO commandstats`/`stats` and
 * Postgres `pg_stat_database` at both ends of a window and reports the delta as
 * a rate, so the same command can be run before and after a phase.
 *
 * Usage:
 *   NODE_OPTIONS='--conditions=ts-source' npx tsx scripts/background-work-baseline.ts \
 *     --seconds 60 --label "phase-0 idle, orchestrator only" --out docs/plans/aflow/evidence/180-baseline.json
 *
 * Read-only: it issues INFO and one pg_stat_database select. Safe against a
 * live system.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Redis from 'ioredis';
import postgres from 'postgres';

interface CommandStat {
  calls: number;
  usec: number;
}

interface Sample {
  atMs: number;
  commands: Record<string, CommandStat>;
  totalCommands: number;
  totalConnections: number;
  keys: number;
  pg?: { xactCommit: number; tupReturned: number; tupFetched: number };
}

interface Args {
  seconds: number;
  label: string;
  out?: string;
  topN: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const out = get('--out');
  return {
    seconds: Number(get('--seconds') ?? 60),
    label: get('--label') ?? 'unlabeled',
    ...(out !== undefined ? { out } : {}),
    topN: Number(get('--top') ?? 25),
  };
}

function parseCommandStats(info: string): Record<string, CommandStat> {
  const out: Record<string, CommandStat> = {};
  for (const line of info.split('\n')) {
    const match = /^cmdstat_([^:]+):calls=(\d+),usec=(\d+)/.exec(line.trim());
    if (!match?.[1] || !match[2] || !match[3]) continue;
    out[match[1]] = { calls: Number(match[2]), usec: Number(match[3]) };
  }
  return out;
}

function parseInfoField(info: string, field: string): number {
  const match = new RegExp(`^${field}:(\\d+)`, 'm').exec(info);
  return match?.[1] !== undefined ? Number(match[1]) : 0;
}

type PgSampler = () => Promise<Sample['pg']>;

async function sample(redis: Redis, samplePg: PgSampler | null): Promise<Sample> {
  const [commandstats, stats, clients, keyspace] = await Promise.all([
    redis.info('commandstats'),
    redis.info('stats'),
    redis.info('clients'),
    redis.info('keyspace'),
  ]);

  const dbLine = /^db\d+:keys=(\d+)/m.exec(keyspace);

  const result: Sample = {
    atMs: Date.now(),
    commands: parseCommandStats(commandstats),
    totalCommands: parseInfoField(stats, 'total_commands_processed'),
    totalConnections: parseInfoField(clients, 'connected_clients'),
    keys: dbLine?.[1] !== undefined ? Number(dbLine[1]) : 0,
  };

  if (samplePg) {
    const pg = await samplePg();
    if (pg) result.pg = pg;
  }

  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 2,
  });

  const databaseUrl = process.env['DATABASE_URL'];
  const sql = databaseUrl !== undefined ? postgres(databaseUrl, { max: 1 }) : null;
  const samplePg: PgSampler | null = sql
    ? async () => {
        const rows = await sql<
          Array<{ xact_commit: string; tup_returned: string; tup_fetched: string }>
        >`SELECT xact_commit, tup_returned, tup_fetched FROM pg_stat_database WHERE datname = current_database()`;
        const row = rows[0];
        if (!row) return undefined;
        return {
          xactCommit: Number(row.xact_commit),
          tupReturned: Number(row.tup_returned),
          tupFetched: Number(row.tup_fetched),
        };
      }
    : null;

  console.info(`[baseline] "${args.label}" — sampling ${String(args.seconds)}s...`);
  const first = await sample(redis, samplePg);
  await new Promise((resolve) => setTimeout(resolve, args.seconds * 1000));
  const second = await sample(redis, samplePg);

  const elapsedSeconds = (second.atMs - first.atMs) / 1000;
  const perCommand = Object.entries(second.commands)
    .map(([command, stat]) => {
      const before = first.commands[command] ?? { calls: 0, usec: 0 };
      const calls = stat.calls - before.calls;
      const usec = stat.usec - before.usec;
      return {
        command,
        calls,
        callsPerSecond: Number((calls / elapsedSeconds).toFixed(3)),
        usecPerCall: calls > 0 ? Number((usec / calls).toFixed(1)) : 0,
      };
    })
    .filter((entry) => entry.calls > 0)
    .sort((a, b) => b.calls - a.calls);

  // Both counters include commands a Lua script issues internally, so neither is
  // a round-trip count: one EVAL that runs a ZRANGEBYSCORE shows up twice. They
  // are reported raw, and the network figure is derived per workload from the
  // per-command breakdown by subtracting the commands known to originate inside
  // a script.
  const commandstatsTotal = perCommand.reduce((sum, entry) => sum + entry.calls, 0);
  const totalCommandsProcessed = second.totalCommands - first.totalCommands;

  const report = {
    label: args.label,
    capturedAt: new Date(second.atMs).toISOString(),
    elapsedSeconds,
    redis: {
      connectedClients: second.totalConnections,
      keys: second.keys,
      commandstatsTotal,
      commandstatsPerSecond: Number((commandstatsTotal / elapsedSeconds).toFixed(2)),
      totalCommandsProcessed,
      totalCommandsProcessedPerSecond: Number((totalCommandsProcessed / elapsedSeconds).toFixed(2)),
      byCommand: perCommand,
    },
    ...(first.pg && second.pg
      ? {
          postgres: {
            transactions: second.pg.xactCommit - first.pg.xactCommit,
            transactionsPerMinute: Number(
              (((second.pg.xactCommit - first.pg.xactCommit) / elapsedSeconds) * 60).toFixed(2),
            ),
            rowsReturned: second.pg.tupReturned - first.pg.tupReturned,
            rowsFetched: second.pg.tupFetched - first.pg.tupFetched,
          },
        }
      : {}),
  };

  console.info('');
  console.info(
    `Redis: ${String(report.redis.commandstatsPerSecond)} commands/s from commandstats, ` +
      `${String(report.redis.totalCommandsProcessedPerSecond)}/s from total_commands_processed ` +
      `(both include Lua-internal calls) over ${String(elapsedSeconds)}s`,
  );
  console.info(
    `Connected clients: ${String(report.redis.connectedClients)}, keys: ${String(report.redis.keys)}`,
  );
  if ('postgres' in report && report.postgres) {
    console.info(`Postgres: ${String(report.postgres.transactionsPerMinute)} transactions/min`);
  }
  console.info('');
  console.info(
    'command'.padEnd(28) + 'calls'.padStart(10) + 'calls/s'.padStart(12) + 'usec/call'.padStart(12),
  );
  for (const entry of perCommand.slice(0, args.topN)) {
    console.info(
      entry.command.padEnd(28) +
        String(entry.calls).padStart(10) +
        entry.callsPerSecond.toFixed(2).padStart(12) +
        entry.usecPerCall.toFixed(1).padStart(12),
    );
  }

  if (args.out !== undefined) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.info(`\nWrote ${args.out}`);
  }

  await redis.quit();
  if (sql) await sql.end();
}

main().catch((error: unknown) => {
  console.error('[baseline] failed', error);
  process.exit(1);
});
