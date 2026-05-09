// Command catalog for the TUI command bar.
//
// Phase 1 introduced the bar and one entry (`agents`).
// Phase 2 filled in the safe-default read-only catalog plus tab
// completion and key-field highlighting.
// Phase 3 adds the powerful (mutating) command families behind a single
// Y/N confirmation gate: `agent <name> rebuild|start|stop|wallet`,
// `model`, `deploy`, `sync`, schedule/task mutators, and
// `heartbeat enable|disable`. The plural `agents rebuild`
// is intentionally NOT included — Track B owns that command and is
// paused pending the operator's A/B/A-admin-gated pick.

import { fetchAgentsAllTeams, fetchAgentsByTeam, fetchTeams, runRemoteCommand } from '../api/manager.js';

export interface CommandContext {
  manager: string;
  executor: string;
  signal: AbortSignal;
  args: string[];
  // Active team name for the X-Id-Team header. When the TUI is on the
  // "All" view, callers may pass a sensible fallback (e.g. the first
  // real team) so dispatched commands don't fall through to whatever
  // the daemon's default team happens to be.
  teamName?: string;
}

export type RiskTier = 'safe' | 'powerful' | 'destructive';
export type CommandResultRenderer = 'auto' | 'json' | 'table';
export type CommandResultRendererSelector = CommandResultRenderer | ((args: string[]) => CommandResultRenderer);

// Phase 6: context for arg-level Tab completion. The TUI assembles
// this once per Tab keypress from data already in scope (allAgents),
// so completers stay synchronous and side-effect-free.
export interface ArgCompleterContext {
  agentNames: string[];
  teamNames: string[];
}

export interface ConfirmPreviewContext {
  teamCounts?: ReadonlyMap<string, number>;
}

export interface CommandSpec {
  name: string;
  description: string;
  // Phase 5: declarative max-tier classification used by the help view
  // and any future surface that wants to colour commands by risk. The
  // tier reflects the WORST thing this catalog entry can do — for
  // hybrid entries like `schedule` (which has both `list` and `remove`
  // subcommands), the tier is the highest reachable level. The runtime
  // gate is still driven by `shouldConfirm`/`shouldRetype` predicates.
  tier: RiskTier;
  resultRenderer?: CommandResultRendererSelector;
  run: (ctx: CommandContext) => Promise<unknown>;
  // Returns true when the args trigger a destructive/mutating handler
  // and the user should see a Y/N prompt before dispatch. Absent or
  // returning false → run immediately (Phase 1/2 behavior).
  shouldConfirm?: (args: string[]) => boolean;
  // Phase 4 escalation. Returns true for high-risk commands that must
  // require the user to retype the exact command line before dispatch.
  // Retype takes precedence over Y/N when both predicates fire, so
  // there is no double-prompt — the user sees the retype prompt only.
  shouldRetype?: (args: string[]) => boolean;
  // One-line preview shown under either prompt to make the op
  // self-documenting (e.g., `delete agent foo`, `cancel running query
  // on agent foo`). Absent or returning null → renderer falls back to
  // the raw command line.
  confirmPreview?: (args: string[], ctx?: ConfirmPreviewContext) => string | null;
  // Phase 6: candidate strings for the arg slot at `slotIndex` (0 =
  // first arg after the command name). Returns ALL candidates for the
  // slot — the caller filters by partial-prefix match. Absent → no
  // arg completion (Phase 1-5 behavior preserved).
  argCompleter?: (slotIndex: number, ctx: ArgCompleterContext) => string[];
}

export type ConfirmationLevel = 'none' | 'yn' | 'retype';

// Build a CommandSpec that forwards to the manager's `/remote` endpoint
// using the action name plus whatever args the user typed after it.
function remote(
  name: string,
  description: string,
  tier: RiskTier,
  extras: Pick<CommandSpec, 'shouldConfirm' | 'shouldRetype' | 'confirmPreview' | 'argCompleter' | 'resultRenderer'> = {},
): CommandSpec {
  return {
    name,
    description,
    tier,
    run: async ({ manager, executor, signal, args, teamName }) => {
      const command = ['/' + name, ...args].join(' ');
      return runRemoteCommand(manager, executor, command, signal, teamName);
    },
    ...extras,
  };
}

// Common slot-0 agent-name completer used by every command whose first
// positional arg is an agent name (output, meta, cancel, clear, delete).
const agentNameSlot0: NonNullable<CommandSpec['argCompleter']> = (slot, ctx) =>
  slot === 0 ? ctx.agentNames : [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// `agent <name> <subAction>` — slot 0 is name, slot 1 is the
// subcommand from a small fixed set.
const AGENT_SUBACTIONS = ['rebuild', 'start', 'stop', 'probe', 'logs', 'wallet', 'heartbeat'];
const agentTwoSlot: NonNullable<CommandSpec['argCompleter']> = (slot, ctx) => {
  if (slot === 0) return ctx.agentNames;
  if (slot === 1) return AGENT_SUBACTIONS;
  return [];
};

// `/model <name> <model>` — slot 0 is name. Model strings are open-
// ended so we don't try to enumerate slot 1.
const modelSlots: NonNullable<CommandSpec['argCompleter']> = (slot, ctx) =>
  slot === 0 ? ctx.agentNames : [];

// `/heartbeat enable|disable <name>` — slot 0 is the subcommand from a
// fixed set, slot 1 is the agent name. Heartbeat status browsing lives
// behind the `h` keybind, so the bare and one-arg read-only forms are
// rejected with a hint at run() time.
const HEARTBEAT_SUBACTIONS = ['enable', 'disable'];
const heartbeatSlots: NonNullable<CommandSpec['argCompleter']> = (slot, ctx) => {
  if (slot === 0) return HEARTBEAT_SUBACTIONS;
  if (slot === 1) return ctx.agentNames;
  return [];
};

// `agents` keeps the Phase 1 cross-team semantics when invoked without
// args. With one team arg, it scopes the list through /agents?team=<name>.
const AGENTS_BULK_ACTIONS = new Set(['rebuild', 'start', 'stop']);
const agentsUsage = 'Usage: /agents [team] | /agents <team> <rebuild|start|stop>';

function summarizeBulkLifecycleError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, ' ').trim())
    .filter(Boolean);
  if (lines.length === 0) return raw.replace(/[\r\n\t]+/g, ' ').trim() || 'unknown error';
  if (lines.length === 1) return lines[0]!;
  return `${lines[0]} (${lines.length - 1} more lines hidden)`;
}

const agentsCommand: CommandSpec = {
  name: 'agents',
  description: 'List agents, or run team lifecycle: `/agents <team> <rebuild|start|stop>`',
  tier: 'powerful',
  // The dashboard already has a dedicated agents view with rich rendering;
  // surfacing :agents as a command is for raw inspection, so force JSON
  // instead of letting auto-detection fold it into a stripped-down table.
  resultRenderer: (args) => (args.length === 2 ? 'table' : 'json'),
  argCompleter: (slot, ctx) => {
    if (slot === 0) return ctx.teamNames;
    if (slot === 1) return Array.from(AGENTS_BULK_ACTIONS);
    return [];
  },
  shouldConfirm: (args) => {
    const action = args[1]?.toLowerCase() ?? '';
    return args.length === 2 && (action === 'rebuild' || action === 'start');
  },
  shouldRetype: (args) => args.length === 2 && args[1]?.toLowerCase() === 'stop',
  confirmPreview: (args, ctx) => {
    if (args.length !== 2) return null;
    const team = (args[0] ?? '<team>').toLowerCase();
    const action = args[1]?.toLowerCase() ?? '';
    if (!AGENTS_BULK_ACTIONS.has(action)) return null;
    const count = ctx?.teamCounts?.get(team);
    const countText = typeof count === 'number' ? `${count} ` : '';
    return `${action} ${countText}agents in team ${team}`;
  },
  run: async ({ manager, executor, signal, args }) => {
    if (args.length > 2) {
      return { ok: false, error: agentsUsage };
    }
    if (args.length === 1) {
      const team = args[0]!.toLowerCase();
      const agents = await fetchAgentsByTeam(manager, team, signal);
      return { count: agents.length, agents };
    }
    if (args.length === 2) {
      const team = args[0]!.toLowerCase();
      const action = args[1]!.toLowerCase();
      if (!AGENTS_BULK_ACTIONS.has(action)) {
        return { ok: false, error: agentsUsage };
      }
      if (team === 'public') {
        return { ok: false, error: 'Bulk lifecycle is not supported for the public team' };
      }
      const agents = await fetchAgentsByTeam(manager, team, signal);
      if (agents.length === 0) {
        return { ok: false, error: `No agents found in team ${team}` };
      }

      const rows: { agent: string; action: string; ok: boolean; error?: string }[] = [];
      // Skip already-running agents on `start` — sending /agent <name> start
      // to a running agent is wasted RPC and may bounce it. Stop and rebuild
      // dispatch unconditionally; rebuild is meant to refresh a live agent.
      const dispatchTargets = action === 'start'
        ? agents.filter((a) => a.status !== 'running')
        : agents;
      const skipped = action === 'start'
        ? agents.filter((a) => a.status === 'running')
        : [];
      for (const a of skipped) {
        rows.push({ agent: a.name, action: 'skip (already running)', ok: true });
      }
      for (let i = 0; i < dispatchTargets.length; i++) {
        const agent = dispatchTargets[i]!;
        try {
          await runRemoteCommand(manager, executor, `/agent ${agent.name} ${action}`, signal, team);
          rows.push({ agent: agent.name, action, ok: true });
        } catch (err: unknown) {
          rows.push({ agent: agent.name, action, ok: false, error: summarizeBulkLifecycleError(err) });
        }
        if (i < dispatchTargets.length - 1) {
          await sleep(250);
        }
      }
      return rows;
    }
    const teams = await fetchTeams(manager, signal);
    const agents = await fetchAgentsAllTeams(manager, teams, signal);
    return { count: agents.length, agents };
  },
};

// `help` is a TUI-side action — invoking it via the bar opens the
// scrollable help view. The `run` body is intentionally inert; the
// App-level submit handler intercepts by name before calling run().
// Listed in the catalog so it shows up in tab completion and in the
// help view itself.
const helpCommand: CommandSpec = {
  name: 'help',
  description: 'Open the scrollable command help (also: ?)',
  tier: 'safe',
  run: async () => ({ tuiAction: 'help' }),
};

const configsCommand: CommandSpec = {
  name: 'configs',
  description: 'Open the navigable configs/*.yaml browser',
  tier: 'safe',
  run: async () => ({ tuiAction: 'configs' }),
};

const outputCommand: CommandSpec = {
  name: 'output',
  description: "Open an agent's navigable ./output browser (`/output <agent>`)",
  tier: 'safe',
  argCompleter: agentNameSlot0,
  resultRenderer: 'table',
  run: async ({ args }) =>
    args[0]
      ? { tuiAction: 'output', agent: args[0] }
      : { ok: false, error: 'Usage: /output <agent>' },
};

// ── Phase 3 predicates ─────────────────────────────────────────────
// These keep a single catalog entry per top-level token (`schedule`,
// `task`, `agent`, `heartbeat`) and decide on the args
// alone whether to pop the confirmation prompt.

const SCHEDULE_MUTATORS = new Set(['add', 'pause', 'resume', 'remove']);
const TASK_MUTATORS = new Set(['create', 'claim', 'done', 'remove', 'delete']);
const AGENT_MUTATORS = new Set(['rebuild', 'start', 'stop', 'wallet']);
const HEARTBEAT_MUTATORS = new Set(['enable', 'disable']);
// Phase 4: subcommands that escalate from Y/N to retype.
const SCHEDULE_RETYPE = new Set(['remove']);
const TASK_RETYPE = new Set(['remove', 'delete']);
// Per-agent stop only needs Y/N. The bulk team-wide /agents <team> stop
// keeps the retype gate (defined inline on agentsCommand).
const AGENT_RETYPE = new Set<string>();

const REGISTRY: Record<string, CommandSpec> = {
  // ── Phase 1 ──────────────────────────────────────────────────────
  agents: agentsCommand,

  // ── Phase 5 TUI action ───────────────────────────────────────────
  help: helpCommand,

  // ── Phase 2: read-only safe defaults ─────────────────────────────
  status: remote('status', 'Team health summary (running/offline + per-agent health)', 'safe', { resultRenderer: 'table' }),
  teams: remote('teams', 'List all teams in the manager DB', 'safe', { resultRenderer: 'table' }),
  team: {
    name: 'team',
    description: 'Show/switch active team; delete empty team: `/team delete <name>`',
    tier: 'powerful',
    shouldConfirm: (args) =>
      args[0]?.toLowerCase() === 'delete' && Boolean(args[1]),
    shouldRetype: (args) => args[0]?.toLowerCase() === 'delete' && Boolean(args[1]),
    confirmPreview: (args) => {
      if (args[0]?.toLowerCase() === 'delete') {
        return args[1] ? `DELETE team ${args[1].toLowerCase()}` : null;
      }
      return null;
    },
    run: async ({ manager, executor, signal, args, teamName }) => {
      // Team names are lowercase by convention. Normalize whichever arg slot
      // carries the team name before dispatch so `/team Idchain` and
      // `/team delete Idchain` work the same as the lowercase form.
      const normalized = args[0]?.toLowerCase() === 'delete'
        ? ['delete', ...(args.slice(1).map((a, i) => i === 0 ? a.toLowerCase() : a))]
        : args.map((a, i) => i === 0 ? a.toLowerCase() : a);
      return runRemoteCommand(manager, executor, ['/team', ...normalized].join(' '), signal, teamName);
    },
  },
  configs: configsCommand,
  output: outputCommand,
  meta: remote('meta', 'Show agent metadata (`/meta <agent>`)', 'safe', { argCompleter: agentNameSlot0 }),
  list: remote('list', 'Show all pending queries in the active team', 'safe', { resultRenderer: 'table' }),

  // ── Phase 2/3/4 hybrids — tier reflects worst-case subcommand ────
  // /schedule and /task are mutation-only in the TUI. The calendar view (`c`)
  // covers schedule browsing and the tasks view (`t`) covers task browsing,
  // so list/show are rejected with a hint pointing at the visual surface.
  schedule: {
    name: 'schedule',
    description: 'Mutate schedules: add/pause/resume (Y/N), remove (retype). Browse with `c`.',
    tier: 'powerful',
    shouldConfirm: (args) => SCHEDULE_MUTATORS.has(args[0]?.toLowerCase() ?? ''),
    shouldRetype: (args) => SCHEDULE_RETYPE.has(args[0]?.toLowerCase() ?? ''),
    confirmPreview: (args) =>
      SCHEDULE_MUTATORS.has(args[0]?.toLowerCase() ?? '')
        ? `schedule ${args.join(' ')}`
        : null,
    run: async ({ manager, executor, signal, args, teamName }) => {
      const sub = args[0]?.toLowerCase() ?? '';
      if (!SCHEDULE_MUTATORS.has(sub)) {
        return {
          ok: false,
          error: 'Use `c` to open the calendar view. /schedule only handles add, pause, resume, remove.',
        };
      }
      return runRemoteCommand(manager, executor, ['/schedule', ...args].join(' '), signal, teamName);
    },
  },
  task: {
    name: 'task',
    description: 'Mutate tasks: create/claim/done (Y/N), remove/delete (retype). Browse with `t`.',
    tier: 'powerful',
    shouldConfirm: (args) => TASK_MUTATORS.has(args[0]?.toLowerCase() ?? ''),
    shouldRetype: (args) => TASK_RETYPE.has(args[0]?.toLowerCase() ?? ''),
    confirmPreview: (args) =>
      TASK_MUTATORS.has(args[0]?.toLowerCase() ?? '') ? `task ${args.join(' ')}` : null,
    run: async ({ manager, executor, signal, args, teamName }) => {
      const sub = args[0]?.toLowerCase() ?? '';
      if (!TASK_MUTATORS.has(sub)) {
        return {
          ok: false,
          error: 'Use `t` to open the tasks view. /task only handles create, claim, done, remove, delete.',
        };
      }
      return runRemoteCommand(manager, executor, ['/task', ...args].join(' '), signal, teamName);
    },
  },
  // ── Phase 3: powerful, always-gated entries ──────────────────────
  agent: remote(
    'agent',
    'Per-agent control: `/agent <name> <rebuild|start|stop|wallet provision|probe|logs>`',
    'powerful',
    {
      shouldConfirm: (args) => AGENT_MUTATORS.has(args[1]?.toLowerCase() ?? ''),
      shouldRetype: (args) => AGENT_RETYPE.has(args[1]?.toLowerCase() ?? ''),
      confirmPreview: (args) => {
        const sub = args[1]?.toLowerCase();
        const name = args[0] ?? '<agent>';
        if (!sub) return null;
        if (sub === 'wallet') return `provision OWS wallet for agent ${name}`;
        if (AGENT_MUTATORS.has(sub)) return `${sub} agent ${name}`;
        return null;
      },
      argCompleter: agentTwoSlot,
    },
  ),
  model: remote('model', 'Set agent model: `/model <agent> <model>`', 'powerful', {
    shouldConfirm: (args) => args.length >= 2,
    confirmPreview: (args) =>
      args.length >= 2 ? `set model ${args[1]} on agent ${args[0]}` : null,
    argCompleter: modelSlots,
  }),
  deploy: remote('deploy', 'Deploy a team config: `/deploy <config-name>`', 'powerful', {
    shouldConfirm: () => true,
    confirmPreview: (args) =>
      args.length > 0 ? `deploy config: ${args.join(' ')}` : 'deploy (no args — will error)',
  }),
  sync: {
    name: 'sync',
    description: 'Sync team against YAML: `/sync <team>`',
    tier: 'powerful',
    shouldConfirm: () => true,
    confirmPreview: (args) => {
      if (args.length === 0) return 'sync (no args — will error)';
      const team = args[0]!.toLowerCase();
      return args.length === 1 ? `sync team: ${team}` : `sync team: ${team} ${args.slice(1).join(' ')}`;
    },
    run: async ({ manager, executor, signal, args, teamName }) => {
      const normalized = args.map((a, i) => (i === 0 ? a.toLowerCase() : a));
      return runRemoteCommand(manager, executor, ['/sync', ...normalized].join(' '), signal, teamName);
    },
  },
  heartbeat: {
    name: 'heartbeat',
    description: 'Toggle heartbeat: `/heartbeat enable|disable <agent>`. Browse with `h`.',
    tier: 'powerful',
    shouldConfirm: (args) => HEARTBEAT_MUTATORS.has(args[0]?.toLowerCase() ?? ''),
    confirmPreview: (args) => {
      const sub = args[0]?.toLowerCase() ?? '';
      const name = args[1] ?? '<agent>';
      return HEARTBEAT_MUTATORS.has(sub) ? `${sub} heartbeat for agent ${name}` : null;
    },
    argCompleter: heartbeatSlots,
    run: async ({ manager, executor, signal, args, teamName }) => {
      const sub = args[0]?.toLowerCase() ?? '';
      if (!HEARTBEAT_MUTATORS.has(sub)) {
        return {
          ok: false,
          error: 'Use `h` to open the heartbeats view. /heartbeat only handles enable, disable.',
        };
      }
      return runRemoteCommand(manager, executor, ['/heartbeat', ...args].join(' '), signal, teamName);
    },
  },

  // ── Phase 4: retype-tier (always-on exact-line confirmation) ─────
  delete: remote(
    'delete',
    'Delete agent(s): `/delete <name>` | `/delete *` | `/delete --team <name>`',
    'destructive',
    {
      shouldRetype: () => true,
      confirmPreview: (args) => {
        const first = args[0];
        if (!first) return 'delete (no args — will error)';
        if (first === '*') return 'DELETE ALL agents in the active team';
        if (first === '--team') {
          const t = args[1];
          return t ? `DELETE ALL agents in team ${t}` : 'delete --team (no team name)';
        }
        return `delete agent ${first}`;
      },
      argCompleter: agentNameSlot0,
    },
  ),
  cancel: remote('cancel', "Cancel an agent's running query: `/cancel <agent>`", 'powerful', {
    shouldRetype: () => true,
    confirmPreview: (args) =>
      args[0] ? `cancel running query on agent ${args[0]}` : 'cancel (no args — will error)',
    argCompleter: agentNameSlot0,
  }),
  clear: remote('clear', "Clear an agent's session: `/clear <agent>`", 'powerful', {
    shouldRetype: () => true,
    confirmPreview: (args) =>
      args[0] ? `clear session on agent ${args[0]}` : 'clear (no args — will error)',
    argCompleter: agentNameSlot0,
  }),
};

export function lookupCommand(name: string): CommandSpec | null {
  return REGISTRY[name] ?? null;
}

export function knownCommandNames(): string[] {
  return Object.keys(REGISTRY).sort();
}

// Phase 4: tri-state gate. Retype takes precedence over Y/N when both
// predicates fire so there is no double-prompt — the user only sees
// the higher-tier prompt. Centralised here so the App-side handler
// doesn't have to know per-spec predicates.
export function confirmationLevel(spec: CommandSpec, args: string[]): ConfirmationLevel {
  if (spec.shouldRetype && spec.shouldRetype(args)) return 'retype';
  if (spec.shouldConfirm && spec.shouldConfirm(args)) return 'yn';
  return 'none';
}

// One-line preview text under the Y/N prompt, or null to fall back to
// the raw command line in the rendering layer.
export function commandConfirmPreview(
  spec: CommandSpec,
  args: string[],
  ctx?: ConfirmPreviewContext,
): string | null {
  return spec.confirmPreview ? spec.confirmPreview(args, ctx) : null;
}

// Phase 5 helper: ordered iteration over all catalog entries grouped
// by tier, used by the help view. Tiers are returned in increasing
// risk order (safe, powerful, destructive); commands within each tier
// are sorted alphabetically. Sourcing from the catalog (rather than a
// hand-maintained list) is mandated by the Phase 5 brief.
// Pinned to the front of their tier in the help catalog, in the order
// listed. Everything else stays alphabetical underneath.
const PINNED_FIRST = ['help'];

export function catalogEntriesByTier(): Record<RiskTier, CommandSpec[]> {
  const out: Record<RiskTier, CommandSpec[]> = {
    safe: [],
    powerful: [],
    destructive: [],
  };
  const pinned = new Set(PINNED_FIRST);
  for (const name of PINNED_FIRST) {
    const spec = lookupCommand(name);
    if (spec) out[spec.tier].push(spec);
  }
  for (const name of knownCommandNames()) {
    if (pinned.has(name)) continue;
    const spec = lookupCommand(name);
    if (!spec) continue;
    out[spec.tier].push(spec);
  }
  return out;
}

// Splits a raw input line (with or without leading `:` / `/`) into
// command name and args. Returns null when the line is empty after
// stripping the prefix.
export function parseCommandLine(raw: string): { name: string; args: string[] } | null {
  const stripped = raw.replace(/^[:/]+/, '').trim();
  if (!stripped) return null;
  const parts = stripped.split(/\s+/);
  return { name: parts[0]!, args: parts.slice(1) };
}

// Top-level tab completion. Operates only on the first token of the
// buffer (i.e. before any whitespace). Returns the new buffer string,
// or null if no completion can be applied.
export function completeCommand(buffer: string): string | null {
  if (buffer.length < 1) return null;
  const sigil = buffer[0];
  if (sigil !== ':' && sigil !== '/') return null;
  const rest = buffer.slice(1);
  if (rest.includes(' ')) return null;
  const matches = knownCommandNames().filter((n) => n.startsWith(rest));
  if (matches.length === 0) return null;
  if (matches.length === 1) {
    if (matches[0] === rest) return null;
    return sigil + matches[0] + ' ';
  }
  let prefix = matches[0]!;
  for (const m of matches.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < m.length && prefix[i] === m[i]) i++;
    prefix = prefix.slice(0, i);
  }
  if (prefix.length <= rest.length) return null;
  return sigil + prefix;
}

// Phase 6: longest-common-prefix helper shared by completeCommand and
// completeBuffer. Returns '' for an empty input, otherwise the prefix
// common to all entries.
function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return '';
  let prefix = strs[0]!;
  for (const s of strs.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

// Phase 6: full tab completion that handles both the first-token slot
// (existing Phase 2 behavior) and arg slots (new). The buffer-aware
// path tokenises the input, decides whether the cursor is on the
// command name or on an arg, and delegates to the resolved spec's
// argCompleter for slot candidates. Returns the new buffer or null.
export function completeBuffer(buffer: string, ctx: ArgCompleterContext): string | null {
  if (buffer.length < 1) return null;
  const sigil = buffer[0];
  if (sigil !== ':' && sigil !== '/') return null;
  const rest = buffer.slice(1);

  // No spaces yet → first-token completion.
  if (!/\s/.test(rest)) {
    return completeCommand(buffer);
  }

  // Tokenise. The "partial" is the trailing token unless the buffer
  // ends in whitespace, in which case the partial is empty (i.e. the
  // user is asking what's next).
  const endsWithSpace = /\s$/.test(rest);
  const tokens = rest.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const name = tokens[0]!;
  const completedArgs = endsWithSpace ? tokens.slice(1) : tokens.slice(1, -1);
  const partial = endsWithSpace ? '' : tokens[tokens.length - 1] ?? '';

  const spec = lookupCommand(name);
  if (!spec || !spec.argCompleter) return null;

  const slot = completedArgs.length;
  const candidates = spec.argCompleter(slot, ctx);
  if (candidates.length === 0) return null;
  const matches = candidates.filter((c) => c.startsWith(partial));
  if (matches.length === 0) return null;

  // Replace the trailing partial in the buffer with either the unique
  // match (+ trailing space) or the longest common prefix (no space).
  const trim = buffer.length - partial.length;
  if (matches.length === 1) {
    if (matches[0] === partial) return null;
    return buffer.slice(0, trim) + matches[0] + ' ';
  }
  const lcp = longestCommonPrefix(matches);
  if (lcp.length <= partial.length) return null;
  return buffer.slice(0, trim) + lcp;
}
