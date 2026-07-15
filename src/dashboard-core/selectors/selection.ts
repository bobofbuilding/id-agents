// SPDX-License-Identifier: MIT
/**
 * Pure list selection + scroll-window clamping. Both the TUI and the Electron
 * dashboard keep a `{ selectedIndex, windowStart }` pair over a virtualized
 * list; this is the renderer-neutral math that keeps the selection in bounds
 * and the window scrolled to reveal it.
 */

/** Clamp a selection index into `[0, total)`. Empty list → 0. */
export function clampIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  // Bound BOTH ends: a negative index (e.g. from a rapid decrement) resolves
  // to 0, an over-range index to total-1.
  return Math.max(0, Math.min(index, total - 1));
}

export interface ScrollState {
  index: number;
  windowStart: number;
}

/**
 * Clamp the selected index into range and scroll the window so it stays
 * visible. Reproduces the identical inline logic the TUI applied per-view:
 *   - empty list → both reset to 0;
 *   - otherwise clamp the index, then shift `windowStart` up if the selection
 *     scrolled above it or down if it scrolled below the window, finally
 *     bounding the start to `[0, max(0, total - windowSize)]`.
 */
export function clampScroll(
  index: number,
  windowStart: number,
  total: number,
  windowSize: number,
): ScrollState {
  if (total <= 0) return { index: 0, windowStart: 0 };
  const clampedIndex = Math.max(0, Math.min(index, total - 1));
  const maxStart = Math.max(0, total - windowSize);
  let nextStart = windowStart;
  if (clampedIndex < nextStart) nextStart = clampedIndex;
  if (clampedIndex >= nextStart + windowSize) nextStart = clampedIndex - windowSize + 1;
  if (nextStart > maxStart) nextStart = maxStart;
  if (nextStart < 0) nextStart = 0;
  return { index: clampedIndex, windowStart: nextStart };
}
