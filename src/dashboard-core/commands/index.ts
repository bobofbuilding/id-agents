// SPDX-License-Identifier: MIT
/**
 * Command-policy barrel — the DELIBERATE public surface of the shared
 * command layer: catalog + risk tiers, confirmation gates, parsing, and
 * completion. Consumers (the TUI execution adapter today; the desktop app
 * via `id-agents/dashboard-core` once the package exports land) import from
 * here or from the dashboard-core root barrel. Deep imports of individual
 * command modules are not part of the public contract.
 *
 * Exports are intentionally NAMED (no `export *`): a future identifier
 * collision anywhere in this surface fails compilation here instead of
 * being silently dropped by ESM `export *` ambiguity rules.
 */

export {
  COMMAND_POLICIES,
  lookupPolicy,
  policyNames,
  catalogEntriesByTier,
  AGENTS_BULK_ACTIONS,
  SCHEDULE_MUTATORS,
  TASK_MUTATORS,
  AGENT_MUTATORS,
  HEARTBEAT_MUTATORS,
} from './catalog.js';

export { completeCommand, completeBuffer } from './completion.js';

export { confirmationLevel, commandConfirmPreview } from './confirmation.js';

export { parseCommandLine } from './parser.js';

export type {
  RiskTier,
  ConfirmationLevel,
  CommandPolicy,
  CommandResultRenderer,
  CommandResultRendererSelector,
  ArgCompleterContext,
  ConfirmPreviewContext,
} from './types.js';
