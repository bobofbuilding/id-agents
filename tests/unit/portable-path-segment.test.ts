// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import {
  isPortableOverlayPathSegment,
  portableOverlayPathSegmentError,
  portablePathSegmentKey,
  portableRelativePathKey,
} from '../../src/lib/portable-path-segment.js';

describe('portable managed path identities', () => {
  it('uses the same NFKC case-fold key for composed and decomposed legacy names', () => {
    expect(portablePathSegmentKey('\u00e9')).toBe(portablePathSegmentKey('e\u0301'));
    expect(portableRelativePathKey('Rules/\u00c9.md'))
      .toBe(portableRelativePathKey('rules/E\u0301.md'));
    expect(portablePathSegmentKey('\uff21lpha')).toBe(portablePathSegmentKey('alpha'));
    expect(portablePathSegmentKey('stra\u00dfe')).toBe(portablePathSegmentKey('STRASSE'));
  });

  it('accepts portable ASCII overlay roots and rejects every non-ASCII segment', () => {
    expect(isPortableOverlayPathSegment('.claude')).toBe(true);
    expect(isPortableOverlayPathSegment('rules and notes')).toBe(true);

    for (const value of ['\u00e9', 'e\u0301', '\uff21lpha', 'emoji-\ud83d\udee1']) {
      expect(portableOverlayPathSegmentError(value)).toMatch(/printable ASCII/i);
      expect(isPortableOverlayPathSegment(value)).toBe(false);
    }
  });

  it('retains portable filesystem and Windows device restrictions', () => {
    for (const value of ['', '.', '..', 'CON', 'nul.txt', 'bad/', 'name.', 'bad ']) {
      expect(portableOverlayPathSegmentError(value)).not.toBeNull();
    }
  });
});
