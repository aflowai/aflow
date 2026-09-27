'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  Column,
  Dialog,
  Divider,
  Field,
  Heading,
  Icon,
  Input,
  Label,
  Row,
  Select,
  Text,
  Textarea,
} from '@aflow/design-system';
import { useTenantOAuthPolicy } from '../../hooks/use-tenant-oauth-clients.js';
import { IntegrationWriteErrorNotice } from '../integrations/IntegrationWriteErrorNotice.js';
import {
  McpAuthFields,
  authProfileToFormState,
  buildAuthProfile,
  extractCredentialWrites,
  isConsentOAuth,
  type McpAuthFormState,
} from './McpAuthFields.js';
import {
  McpToolFilterFields,
  stateToToolFilter,
  toolFilterToState,
  type ToolFilterState,
} from './McpAclFields.js';
import type { IntegrationCredentialMeta } from '../../hooks/use-integrations.js';
import type {
  McpBindingTestResult,
  McpServerBindingSummary,
  McpServerDefinitionSummary,
  SaveMcpBindingInput,
  SaveMcpServerInput,
} from './use-mcp-integrations.js';
import { preservedBindingScope } from '../integrations/bindingScope.js';

type SaveStep = 'idle' | 'saving' | 'connecting' | 'enabling' | 'done';

/** Slugify a free-text name into a server-id candidate. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Default bindingId derived from the serverId on first save. */
function defaultBindingId(serverId: string): string {
  const slug = slugify(serverId);
  return slug ? `${slug}-default` : 'default';
}

/**
 * Extract every `credentialKey` reference from an auth-profile blob. Used
 * to garbage-collect stranded credential rows when the operator changes
 * the auth shape mid-edit (e.g., bearer's `credentialKey` becomes
 * irrelevant after switching to oauth2's `clientIdCredentialKey` +
 * `clientSecretCredentialKey`). Mirrors `extractCredentialKeys` on the
 * server so client + server stay in sync.
 */
function collectAuthCredentialKeys(auth: Record<string, unknown>): string[] {
  const keys: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.length > 0) keys.push(v);
  };
  add(auth['credentialKey']);
  add(auth['usernameCredentialKey']);
  add(auth['passwordCredentialKey']);
  add(auth['clientIdCredentialKey']);
  add(auth['clientSecretCredentialKey']);
  return keys;
}

/**
 * Single-dialog editor for an MCP integration — collapses what were two
 * separate dialogs (server definition + connection) into one form. On
 * save, atomically: upsert definition → upsert binding (disabled
 * initially if credentialed) → write credentials → run test if
 * credentialed + has secret → on success, re-upsert binding with
 * enabled:true.
 */
export function McpIntegrationFormDialog({
  initialDefinition,
  initialBinding,
  credentials,
  onSaveDefinition,
  onSaveBinding,
  onSaveCredential,
  onDeleteCredential,
  onTest,
  onClose,
}: {
  /** When set, the form is in edit mode and Server ID is locked. */
  initialDefinition?: McpServerDefinitionSummary;
  /** When the integration already has a connection, hydrate auth + advanced fields. */
  initialBinding?: McpServerBindingSummary;
  credentials: IntegrationCredentialMeta[];
  onSaveDefinition: (body: SaveMcpServerInput) => Promise<void>;
  onSaveBinding: (body: SaveMcpBindingInput) => Promise<void>;
  /** PUT a credential value against a key. Fires per slot that carried a value. */
  onSaveCredential: (key: string, value: string, label: string) => Promise<void>;
  /**
   * DELETE an old credential row after the operator changes the credential
   * key (e.g., switching auth types from bearer to oauth2 leaves the prior
   * `bearer.credentialKey` stranded). Fires for any key that was on the
   * binding when the form opened but is no longer referenced.
   */
  onDeleteCredential: (key: string) => Promise<void>;
  /** Run mcp.binding.test against the saved binding. */
  onTest: (bindingId: string) => Promise<McpBindingTestResult>;
  onClose: () => void;
}) {
  const editing = Boolean(initialDefinition);
  const { policy: oauthPolicy } = useTenantOAuthPolicy();

  // === Basics ===
  const [serverId, setServerId] = useState(initialDefinition?.serverId ?? '');
  const [serverIdTouched, setServerIdTouched] = useState(Boolean(initialDefinition?.serverId));
  const [name, setName] = useState(initialDefinition?.name ?? '');
  const [description, setDescription] = useState(initialDefinition?.description ?? '');
  const [serverUrl, setServerUrl] = useState(initialDefinition?.serverUrl ?? '');

  // === Authentication ===
  // Hydrate the auth shape from auth_json, but the ownership axes from the
  // binding's top-level owner_scope/client_scope COLUMNS (the source of truth);
  // they are never round-tripped through auth_json.
  const [auth, setAuth] = useState<McpAuthFormState>(
    initialBinding
      ? {
          ...authProfileToFormState(initialBinding.auth),
          ...(initialBinding.ownerScope ? { ownerScope: initialBinding.ownerScope } : {}),
          ...(initialBinding.clientScope ? { clientScope: initialBinding.clientScope } : {}),
        }
      : { type: 'bearer' },
  );

  // Seed the ownership axes from the tenant policy default the first time a
  // consent OAuth type is selected and the binding doesn't already carry them
  // (a freshly-created binding, or one hydrated from a pre-ownership profile).
  // Never overwrites an operator's explicit choice or an edited binding's
  // stored scope.
  useEffect(() => {
    if (!isConsentOAuth(auth.type)) return;
    if (auth.ownerScope && auth.clientScope) return;
    if (!oauthPolicy) return;
    setAuth((prev) =>
      prev.ownerScope && prev.clientScope
        ? prev
        : {
            ...prev,
            ownerScope: prev.ownerScope ?? oauthPolicy.defaultOwnerScope,
            clientScope: prev.clientScope ?? oauthPolicy.defaultClientScope,
          },
    );
  }, [auth.type, auth.ownerScope, auth.clientScope, oauthPolicy]);

  // === Tool permissions ===
  const [toolFilter, setToolFilter] = useState<ToolFilterState>(
    toolFilterToState(initialDefinition?.toolFilter ?? null),
  );

  // === Advanced ===
  const [bindingId, setBindingId] = useState(initialBinding?.bindingId ?? '');
  const [subscribeListChanged, setSubscribeListChanged] = useState(
    initialBinding?.subscribeListChanged ?? true,
  );
  const [samplingPolicy, setSamplingPolicy] = useState<'off' | 'no_tools' | 'full'>(
    (initialBinding?.samplingPolicy as 'off' | 'no_tools' | 'full' | undefined) ?? 'off',
  );
  const [prmPath, setPrmPath] = useState('');
  const [tags, setTags] = useState((initialDefinition?.tags ?? []).join(', '));
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // === Save state ===
  const [step, setStep] = useState<SaveStep>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);

  const saving = step !== 'idle' && step !== 'done';
  const credentialed = auth.type !== 'none';

  // Derived bindingId for the auth-fields default-key seeding (uses the
  // saved/current bindingId if present, otherwise an auto-derived one).
  const effectiveBindingId = useMemo(() => {
    if (bindingId.trim()) return bindingId.trim();
    if (serverId.trim()) return defaultBindingId(serverId);
    return '';
  }, [bindingId, serverId]);

  // Auto-derive serverId from name on create (until the operator touches it).
  const onNameChange = (value: string) => {
    setName(value);
    if (!editing && !serverIdTouched) {
      setServerId(slugify(value));
    }
  };

  const stepLabel: Record<SaveStep, string> = {
    idle: '',
    saving: 'Saving integration…',
    connecting: 'Connecting to server…',
    enabling: 'Finishing setup…',
    done: 'Done',
  };

  const handleSave = useCallback(async () => {
    setErrorMsg(null);
    setSaveError(null);

    const trimmedServerId = serverId.trim();
    const trimmedName = name.trim();
    const trimmedUrl = serverUrl.trim();

    if (!trimmedServerId || !trimmedName || !trimmedUrl) {
      setErrorMsg('Name and Server URL are required.');
      return;
    }
    try {
      new URL(trimmedUrl);
    } catch {
      setErrorMsg('Server URL must be a valid URL.');
      return;
    }
    if (auth.type === 'header' && !auth.headerName?.trim()) {
      setErrorMsg('Header name is required for header auth.');
      return;
    }
    if (auth.type === 'oauth2_client_credentials' && !auth.tokenEndpoint?.trim()) {
      setErrorMsg('Token URL is required for OAuth client credentials.');
      return;
    }
    if (auth.type === 'oauth2_cimd' && !auth.clientIdMetadataUrl?.trim()) {
      setErrorMsg('Client metadata URL is required for OAuth (no pre-registration).');
      return;
    }

    const finalBindingId = bindingId.trim() || defaultBindingId(trimmedServerId);
    if (!bindingId.trim()) setBindingId(finalBindingId);

    const tagList = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const filterOut = stateToToolFilter(toolFilter);
    const defPayload: SaveMcpServerInput = {
      serverId: trimmedServerId,
      name: trimmedName,
      serverUrl: trimmedUrl,
      transport: 'streamable_http',
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(tagList.length > 0 ? { tags: tagList } : {}),
      ...(prmPath.trim() ? { protectedResourceMetadataPath: prmPath.trim() } : {}),
      ...(filterOut ? { toolFilter: filterOut } : {}),
      ...(editing ? {} : { source: 'custom' as const }),
    };

    const writes = extractCredentialWrites(auth, finalBindingId);
    const hasSecret = writes.length > 0;

    const willTest = credentialed && (hasSecret || Boolean(initialBinding));

    // Credentialed bindings that will be (re-)tested stay disabled until the
    // test pins origin — including edits to an already-enabled integration
    // (changing serverUrl/auth with enabled:true + stale pin → origin_mismatch).
    // Non-credentialed bindings can enable immediately; new credentialed rows
    // without a typed secret land disabled until the operator returns with one.
    const bindingEnabled = !credentialed || (!willTest && Boolean(initialBinding?.pinnedOrigin));

    const bindingBase: SaveMcpBindingInput = {
      bindingId: finalBindingId,
      serverId: trimmedServerId,
      name: trimmedName,
      ...(description.trim() ? { description: description.trim() } : {}),
      // Composed by the API from the authenticated request. A browser that
      // cannot know the tenant was sending a placeholder into stored data —
      // but an edit still has to carry its own flow scope or lose it.
      scope: preservedBindingScope(initialBinding),
      auth: buildAuthProfile(auth),
      subscribeListChanged,
      samplingPolicy,
      // For consent OAuth the ownership axes are persisted ONLY as the top-level
      // owner_scope/client_scope columns the executor + consent route read.
      ...(isConsentOAuth(auth.type)
        ? {
            ownerScope: auth.ownerScope ?? 'space',
            clientScope: auth.clientScope ?? 'platform',
          }
        : {}),
      enabled: bindingEnabled,
    };

    // Diff old vs new credential keys so we can clean up stranded rows
    // after the binding write — switching auth types (bearer → oauth2,
    // changing a slot's credentialKey) used to leave the old credential
    // row in the tenant store with no reference. Credentials belong to
    // the integration, so we GC them here.
    const oldKeys = new Set(initialBinding ? collectAuthCredentialKeys(initialBinding.auth) : []);
    const newKeys = new Set(collectAuthCredentialKeys(buildAuthProfile(auth)));
    const orphanedKeys = [...oldKeys].filter((k) => !newKeys.has(k));

    try {
      setStep('saving');
      await onSaveDefinition(defPayload);
      await onSaveBinding(bindingBase);
      for (const w of writes) {
        await onSaveCredential(w.key, w.value, w.label);
      }
      for (const k of orphanedKeys) {
        try {
          await onDeleteCredential(k);
        } catch {
          // Best-effort — a stranded credential row left behind from a
          // changed auth shape isn't worth failing the save over. The
          // operator can clean it up via the Integrations UI on the next
          // edit.
        }
      }

      if (!willTest) {
        setStep('done');
        onClose();
        return;
      }

      setStep('connecting');
      const result = await onTest(finalBindingId);
      if (!result.ok) {
        setErrorMsg(
          result.message
            ? `Couldn't connect: ${result.message}. You can still save and try again later from the integration card.`
            : "Couldn't connect. You can still save and try again later from the integration card.",
        );
        setStep('idle');
        return;
      }

      // Flip to enabled now that the origin is pinned.
      setStep('enabling');
      await onSaveBinding({ ...bindingBase, enabled: true });
      setStep('done');
      onClose();
    } catch (err) {
      setSaveError(err);
      setStep('idle');
    }
  }, [
    serverId,
    name,
    serverUrl,
    auth,
    bindingId,
    tags,
    description,
    prmPath,
    toolFilter,
    editing,
    credentialed,
    initialBinding,
    subscribeListChanged,
    samplingPolicy,
    onSaveDefinition,
    onSaveBinding,
    onSaveCredential,
    onDeleteCredential,
    onTest,
    onClose,
  ]);

  // Union of available tools across the binding's cached list — surfaces the
  // tool-filter UI with autocomplete chips.
  const availableTools = useMemo<string[]>(() => {
    return Array.from(new Set(initialBinding?.cachedToolNames ?? []));
  }, [initialBinding?.cachedToolNames]);

  return (
    <Dialog open onClose={onClose} title={editing ? 'Edit MCP integration' : 'Add MCP integration'}>
      <Column
        gap="3"
        style={{
          padding: 'var(--space-4)',
          maxWidth: 600,
          width: '100%',
          backdropFilter: 'blur(10px)',
        }}
      >
        {/* === Basics === */}
        <Heading level={5}>Basics</Heading>
        <Row gap="3">
          <div style={{ flex: 1 }}>
            <Field>
              <Label>Integration name</Label>
              <Input
                value={name}
                onChange={(e) => {
                  onNameChange(e.target.value);
                }}
                placeholder="e.g. Kaggle"
              />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field>
              <Label>Server ID</Label>
              <Input
                value={serverId}
                onChange={(e) => {
                  setServerIdTouched(true);
                  setServerId(e.target.value);
                }}
                placeholder="auto"
                disabled={editing}
              />
            </Field>
          </div>
        </Row>

        <Field>
          <Label>Server URL</Label>
          <Input
            value={serverUrl}
            onChange={(e) => {
              setServerUrl(e.target.value);
            }}
            placeholder="https://www.kaggle.com/mcp"
          />
        </Field>

        <Field>
          <Label>Description</Label>
          <Textarea
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
            }}
            placeholder="What this MCP server provides (visible to agents in catalog context)."
            rows={3}
          />
        </Field>

        <Divider />

        {/* === Authentication === */}
        <Heading level={5}>Authentication</Heading>
        <McpAuthFields
          state={auth}
          bindingId={effectiveBindingId}
          onChange={setAuth}
          credentials={credentials}
        />

        <Divider />

        {/* === Tool permissions === */}
        <McpToolFilterFields
          state={toolFilter}
          onChange={setToolFilter}
          availableTools={availableTools}
        />

        {/* === Advanced (collapsed) === */}
        <details
          open={advancedOpen}
          onToggle={(e) => {
            setAdvancedOpen((e.target as HTMLDetailsElement).open);
          }}
          style={{ marginTop: 'var(--space-2)' }}
        >
          <summary style={{ cursor: 'pointer', fontSize: 'var(--font-size-sm)' }}>Advanced</summary>
          <Column gap="3" style={{ marginTop: 'var(--space-2)' }}>
            <Field>
              <Label>Connection ID</Label>
              <Input
                value={bindingId}
                onChange={(e) => {
                  setBindingId(e.target.value);
                }}
                placeholder="auto-generated from Server ID"
                disabled={Boolean(initialBinding)}
              />
              <Text size="xs" color="muted">
                Internal identifier for the underlying binding. Auto-generated — rarely changed.
              </Text>
            </Field>
            <Field>
              <Label>Subscribe to list_changed</Label>
              <Checkbox
                checked={subscribeListChanged}
                onChange={(e) => {
                  setSubscribeListChanged(e.target.checked);
                }}
              >
                Auto-refresh the tool list when the server adds tools
              </Checkbox>
            </Field>
            <Field>
              <Label>AI sampling from the server</Label>
              <Select
                value={samplingPolicy}
                onChange={(e) => {
                  setSamplingPolicy(e.target.value as 'off' | 'no_tools' | 'full');
                }}
              >
                <option value="off">Off — server cannot ask the agent to run AI</option>
                <option value="no_tools">Allow — but server cannot trigger tool calls</option>
                <option value="full">Allow — including tool calls (subject to permissions)</option>
              </Select>
            </Field>
            <Field>
              <Label>OAuth PRM path (optional)</Label>
              <Input
                value={prmPath}
                onChange={(e) => {
                  setPrmPath(e.target.value);
                }}
                placeholder="Default: /.well-known/oauth-protected-resource"
              />
            </Field>
            <Field>
              <Label>Tags (comma-separated)</Label>
              <Input
                value={tags}
                onChange={(e) => {
                  setTags(e.target.value);
                }}
                placeholder="e.g. data, datasets"
              />
            </Field>
          </Column>
        </details>

        {step !== 'idle' && step !== 'done' && (
          <Row gap="2" align="center">
            <Icon name="spinner" size="sm" />
            <Text size="sm" color="secondary">
              {stepLabel[step]}
            </Text>
          </Row>
        )}

        {errorMsg && (
          <Row gap="2" align="start">
            <Badge variant="warning">
              <Icon name="warning-circle" size="xs" />
            </Badge>
            <Text size="sm" tone="danger" style={{ flex: 1 }}>
              {errorMsg}
            </Text>
          </Row>
        )}
        {saveError != null && <IntegrationWriteErrorNotice error={saveError} kind="mcp" />}

        <Row justify="end" gap="2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? stepLabel[step] : 'Save & connect'}
          </Button>
        </Row>
      </Column>
    </Dialog>
  );
}
