// SPDX-License-Identifier: MIT
/**
 * Renderer-neutral command POLICY types.
 *
 * The policy layer describes WHAT a command is — its catalog metadata, risk
 * tier, confirmation gates, one-line previews, argument completion, and result
 * rendering hint. It deliberately contains no execution: how a command is
 * dispatched (manager `/remote`, a TUI navigation action, …) lives in each
 * surface's own adapter (`src/tui/commands/registry.ts` for the terminal).
 */

/** Worst-case risk classification for a catalog entry. */
export type RiskTier = 'safe' | 'powerful' | 'destructive';

/** How the renderer should present a command's structured result. */
export type CommandResultRenderer = 'auto' | 'json' | 'table';
export type CommandResultRendererSelector =
  | CommandResultRenderer
  | ((args: string[]) => CommandResultRenderer);

/** The tri-state confirmation a command's args resolve to. */
export type ConfirmationLevel = 'none' | 'yn' | 'retype';

/**
 * Context for arg-level Tab completion, assembled by the renderer from data
 * already in scope so completers stay synchronous and side-effect-free.
 */
export interface ArgCompleterContext {
  agentNames: string[];
  teamNames: string[];
}

export interface ConfirmPreviewContext {
  teamCounts?: ReadonlyMap<string, number>;
}

/**
 * The renderer-neutral policy for one command. This is the former `CommandSpec`
 * minus its `run` execution — surfaces attach their own runner to build a
 * concrete, executable command.
 */
export interface CommandPolicy {
  name: string;
  description: string;
  /**
   * Declarative max-tier classification used by the help view and any surface
   * that colours commands by risk. Reflects the WORST thing the entry can do;
   * the runtime gate is still driven by `shouldConfirm`/`shouldRetype`.
   */
  tier: RiskTier;
  resultRenderer?: CommandResultRendererSelector;
  /** True when the args trigger a mutating handler that needs a Y/N prompt. */
  shouldConfirm?: (args: string[]) => boolean;
  /** True for high-risk args that must require retyping the exact command line. */
  shouldRetype?: (args: string[]) => boolean;
  /** One-line preview shown under a prompt, or null to fall back to the raw line. */
  confirmPreview?: (args: string[], ctx?: ConfirmPreviewContext) => string | null;
  /** Candidate strings for the arg slot at `slotIndex` (0 = first arg). */
  argCompleter?: (slotIndex: number, ctx: ArgCompleterContext) => string[];
}
