// SPDX-License-Identifier: MIT
/**
 * Universal mail provider adapter contract.
 *
 * This is the seam a new mail provider (Outlook/Graph, a generic IMAP/SMTP
 * bridge, a reviewed MCP mail server, ...) plugs into: supply a
 * MailProviderDefinition (connector identity + backend binding + any
 * resource-name/schema aliasing) and get back a ConnectorManifest built
 * from the shared MAIL_CAPABILITY_SCHEMA. The registry, grants, policy,
 * router, and audit layers already operate only on ConnectorManifest /
 * CapabilityManifestEntry / capabilityId + resourceScope.accountRef — none
 * of that layer changes to add a provider. Per-agent/account/action grants
 * (grants/grant-evaluator.ts, grants/grants-repo.ts) are untouched by this
 * module; a provider's capabilities are just more capabilityIds to grant
 * against, scoped the same way Gmail's are today.
 *
 * Gmail is the reference implementation of this contract (see
 * providers/gmail/gmail-manifest.ts) — its manifest is generated through
 * buildMailManifest() rather than hand-written, and is verified
 * byte-for-byte/hash-identical to the pre-adapter manifest by
 * tests/unit/connectors/mail-provider-adapter.test.ts.
 */

import type { ConnectorManifest, ConnectorRecord, CapabilityManifestEntry, BackendKind } from '../../types.js';
import type { ConnectorRegistry } from '../../catalog/connector-registry.js';
import { MAIL_CAPABILITY_SCHEMA, type MailCapabilitySchemaEntry } from './mail-schema.js';

export interface MailProviderBackend {
  kind: BackendKind;
  /** Provider identity as recorded on the manifest, e.g. "google", "microsoft". Never a secret. */
  provider: string;
  /** Reviewed backend-binding name (see catalog/backend-bindings.ts) — never a raw origin/secret. */
  binding: string;
}

export interface MailProviderDefinition {
  connectorId: string;
  version: string;
  displayName: string;
  description: string;
  owner: string;
  trustTier: ConnectorRecord['trustTier'];
  backend: MailProviderBackend;
  /** Per-schema-key resource-name override, e.g. Gmail aliasing the canonical "folders" resource to "labels". */
  resourceAliases?: Partial<Record<string, string>>;
  /** Per-schema-key id-suffix override, e.g. Gmail's account-control settings surface is specifically "forwarding". */
  idSuffixAliases?: Partial<Record<string, string>>;
  /** Per-schema-key field overrides (e.g. a tighter inputSchema); shallow-merged onto the schema entry. */
  capabilityOverrides?: Partial<Record<string, Partial<Omit<MailCapabilitySchemaEntry, 'key'>>>>;
  /** Restrict the manifest to a subset of schema keys; defaults to the full universal set. */
  includeKeys?: string[];
}

function buildCapability(entry: MailCapabilitySchemaEntry, def: MailProviderDefinition): CapabilityManifestEntry {
  const override = def.capabilityOverrides?.[entry.key] ?? {};
  const resource = def.resourceAliases?.[entry.key] ?? override.resource ?? entry.resource;
  const idSuffix = def.idSuffixAliases?.[entry.key] ?? override.idSuffix ?? entry.idSuffix ?? entry.operation;
  const merged: Omit<MailCapabilitySchemaEntry, 'key'> = { ...entry, ...override, resource };
  return {
    id: `${def.connectorId}.${resource}.${idSuffix}`,
    operation: merged.operation,
    resource: merged.resource,
    risk: merged.risk,
    sideEffect: merged.sideEffect,
    approval: merged.approval,
    ...(merged.inputSchema !== undefined ? { inputSchema: merged.inputSchema } : {}),
    ...(merged.hardDeny !== undefined ? { hardDeny: merged.hardDeny } : {}),
    ...(merged.notes !== undefined ? { notes: merged.notes } : {}),
  };
}

/** Build a ConnectorManifest for a mail provider from the shared universal schema. */
export function buildMailManifest(def: MailProviderDefinition): ConnectorManifest {
  const keys = def.includeKeys ?? MAIL_CAPABILITY_SCHEMA.map((e) => e.key);
  const keySet = new Set(keys);
  const capabilities = MAIL_CAPABILITY_SCHEMA.filter((entry) => keySet.has(entry.key)).map((entry) =>
    buildCapability(entry, def),
  );
  return {
    connectorId: def.connectorId,
    version: def.version,
    backend: { kind: def.backend.kind, provider: def.backend.provider, binding: def.backend.binding },
    capabilities,
  };
}

/** Capability ids a grant may reference (excludes hard-denied entries). */
export function grantableCapabilityIds(manifest: ConnectorManifest): string[] {
  return manifest.capabilities.filter((c) => !c.hardDeny).map((c) => c.id);
}

/**
 * Register and publish a mail provider's connector against a registry. Pure
 * catalog bootstrap — no connection, grant, credential, or network action.
 */
export async function bootstrapMailConnector(
  registry: ConnectorRegistry,
  def: MailProviderDefinition,
  manifest: ConnectorManifest,
  now = Date.now(),
): Promise<void> {
  await registry.registerConnector({
    id: def.connectorId,
    displayName: def.displayName,
    description: def.description,
    owner: def.owner,
    trustTier: def.trustTier,
    now,
  });
  await registry.draftVersion(manifest, def.backend.kind, now);
  await registry.publishVersion(def.connectorId, def.version, now);
}
