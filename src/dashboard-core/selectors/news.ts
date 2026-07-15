// SPDX-License-Identifier: MIT
/** Pure news selection seams. */

import type { NewsItem } from '../api/types.js';

/** Newest-first copy of the news items (does not mutate the input). */
export function sortNewsByTimestamp(items: NewsItem[]): NewsItem[] {
  return [...items].sort((a, b) => b.timestamp - a.timestamp);
}
