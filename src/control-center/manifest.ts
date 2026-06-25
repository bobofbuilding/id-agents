// SPDX-License-Identifier: MIT
/**
 * Control Center extension manifest.
 *
 * The desktop/TUI Control Center (idctl / idctl-desktop) depends on a set of manager routes
 * that are LOCAL EXTENSIONS — not present in upstream idchain-world/id-agents. This module makes
 * that dependency surface explicit and versioned so the GUI can feature-detect via GET /capabilities
 * and degrade gracefully against a stock manager instead of hard-failing on a 404.
 *
 * This is the seam for Phase 1 of the CC refactor (see brain/control-center/cc-refactor-plan.md):
 * the route HANDLERS still live in agent-manager-db.ts for now and migrate into this module over
 * subsequent passes; this manifest is the single source of truth for the contract today.
 */

export const CC_API_VERSION = 1;

export interface CcRoute {
  method: string;
  path: string;
  group: string;
}

/** Manager routes the Control Center relies on that do NOT exist in upstream id-agents. */
export const CC_ROUTES: CcRoute[] = [
  { method: 'GET', path: '/capabilities', group: 'core' },
  // observability (live display)
  { method: 'GET', path: '/activity', group: 'observability' },
  { method: 'POST', path: '/activity/record', group: 'observability' },
  { method: 'GET', path: '/usage', group: 'observability' },
  { method: 'POST', path: '/usage/record', group: 'observability' },
  { method: 'GET', path: '/usage/by-task', group: 'observability' },
  // per-agent configuration
  { method: 'GET', path: '/agents/:id/instructions', group: 'agent-config' },
  { method: 'POST', path: '/agents/:id/instructions', group: 'agent-config' },
  { method: 'POST', path: '/agents/:id/runtime', group: 'agent-config' },
  { method: 'POST', path: '/agents/:id/mcp', group: 'agent-config' },
  { method: 'POST', path: '/agents/:id/delegates', group: 'agent-config' },
  { method: 'POST', path: '/agents/:id/team', group: 'agent-config' },
  { method: 'POST', path: '/agents/:id/metadata', group: 'agent-config' },
  // team configuration
  { method: 'GET', path: '/teams/:name/config', group: 'team-config' },
  { method: 'POST', path: '/teams/:name/delegates', group: 'team-config' },
  // library (skills / plugins install)
  { method: 'GET', path: '/library/plugins', group: 'library' },
  { method: 'POST', path: '/library/skills/install', group: 'library' },
];

/** Coarse feature flags the GUI can gate on. */
export const CC_FEATURES = [
  'observability', // /activity, /usage, /usage/by-task
  'agent-config', // per-agent instructions/runtime/mcp/delegates/team/metadata
  'team-config', // per-team relay config
  'library', // skills/plugins install
  'brain-context', // brain volunteer hook on dispatch
  'stalled-sweep', // always-on supervision sweeper
] as const;

export function ccCapabilities(): {
  cc_api_version: number;
  extension: string;
  features: readonly string[];
  routes: CcRoute[];
} {
  return {
    cc_api_version: CC_API_VERSION,
    extension: 'id-agents-control-center',
    features: CC_FEATURES,
    routes: CC_ROUTES,
  };
}
