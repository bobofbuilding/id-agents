// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { helpWindowSizeForRows } from '../../src/tui/App.js';
import { HELP_VIEW_CHROME_ROWS } from '../../src/tui/components/HelpView.js';

describe('TUI help view sizing', () => {
  it('reserves help-specific chrome so the modal fits in the terminal', () => {
    expect(HELP_VIEW_CHROME_ROWS).toBe(4);
    expect(helpWindowSizeForRows(24)).toBe(20);
    expect(helpWindowSizeForRows(30)).toBe(26);
  });

  it('keeps at least a minimal viewport in short terminals', () => {
    expect(helpWindowSizeForRows(5)).toBe(3);
  });
});
