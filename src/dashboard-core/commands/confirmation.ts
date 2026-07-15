// SPDX-License-Identifier: MIT
/** Renderer-neutral confirmation gating derived from a command policy. */

import type { CommandPolicy, ConfirmationLevel, ConfirmPreviewContext } from './types.js';

/**
 * Tri-state gate. Retype takes precedence over Y/N when both predicates fire,
 * so the user only ever sees the higher-tier prompt (no double-prompt).
 */
export function confirmationLevel(policy: CommandPolicy, args: string[]): ConfirmationLevel {
  if (policy.shouldRetype && policy.shouldRetype(args)) return 'retype';
  if (policy.shouldConfirm && policy.shouldConfirm(args)) return 'yn';
  return 'none';
}

/**
 * One-line preview text shown under a prompt, or null to fall back to the raw
 * command line in the rendering layer.
 */
export function commandConfirmPreview(
  policy: CommandPolicy,
  args: string[],
  ctx?: ConfirmPreviewContext,
): string | null {
  return policy.confirmPreview ? policy.confirmPreview(args, ctx) : null;
}
