// SPDX-License-Identifier: MIT
/**
 * Reviewed backend-binding registry: maps a manifest's `backend.binding`
 * name to the exact allowlisted transport origin/identity it is pinned to.
 * A manifest never carries the origin/secret directly — only this stable
 * name — so rotating or reviewing an endpoint never requires republishing
 * every connector version that references it.
 *
 * This is a fixed, in-repo table rather than a DB-backed one in this slice:
 * the set of reviewed bindings is small and every entry requires a code
 * review, matching the "no agent-supplied backend/origin" invariant the
 * router depends on.
 */

export const REVIEWED_BACKEND_BINDINGS: Record<string, string> = {
  'google-gmail-v1': 'https://gmail.googleapis.com',
};

export function resolveBindingOrigin(bindingName: string): string | null {
  return REVIEWED_BACKEND_BINDINGS[bindingName] ?? null;
}
