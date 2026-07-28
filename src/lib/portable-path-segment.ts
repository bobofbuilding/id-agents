// SPDX-License-Identifier: MIT

const PORTABLE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WINDOWS_DEVICE_BASENAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const PORTABLE_OVERLAY_FORBIDDEN = /[/\\<>:"|?*]/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/**
 * NFKC + case-fold key used for materialized filesystem identities on every
 * host OS. This also safely compares legacy or existing names before the
 * printable-ASCII managed-name policy is applied.
 */
export function portablePathSegmentKey(value: string): string {
  // The upper/lower round trip conservatively expands multi-code-point folds
  // such as ß -> ss, which plain toLowerCase() does not cover.
  return value.normalize('NFKC').toUpperCase().toLowerCase();
}

/** Identity key for a portable relative path; this does not validate it. */
export function portableRelativePathKey(value: string): string {
  return value
    .replaceAll('\\', '/')
    .split('/')
    .map(portablePathSegmentKey)
    .join('/');
}

/**
 * Managed overlay paths allow dot-prefixed runtime roots such as `.claude`,
 * but deliberately reject every non-ASCII segment. This is stronger than
 * relying on host-specific Unicode normalization and case-fold behavior.
 */
export function portableOverlayPathSegmentError(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return 'must be a non-empty string';
  }
  if (value === '.' || value === '..') {
    return 'must not be "." or ".."';
  }
  if (!PRINTABLE_ASCII.test(value)) {
    return 'must contain printable ASCII characters only';
  }
  if (PORTABLE_OVERLAY_FORBIDDEN.test(value)) {
    return 'must not contain portable-filesystem reserved characters';
  }
  if (value.endsWith('.') || value.endsWith(' ')) {
    return 'must not end with a dot or space';
  }
  const basename = value.split('.')[0];
  if (WINDOWS_DEVICE_BASENAME.test(basename)) {
    return 'uses a Windows-reserved device basename';
  }
  return null;
}

export function isPortableOverlayPathSegment(value: unknown): value is string {
  return portableOverlayPathSegmentError(value) === null;
}

/**
 * Return a user-facing reason when a declarative name is not one portable,
 * cross-platform filesystem segment.
 */
export function portablePathSegmentError(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return 'must be a non-empty string';
  }
  if (value.endsWith('.') || value.endsWith(' ')) {
    return 'must not end with a dot or space';
  }
  if (!PORTABLE_SEGMENT_PATTERN.test(value)) {
    return 'must contain only ASCII letters, numbers, dots, underscores, and hyphens, and start with a letter or number';
  }
  const basename = value.split('.')[0];
  if (WINDOWS_DEVICE_BASENAME.test(basename)) {
    return 'uses a Windows-reserved device basename';
  }
  return null;
}

export function isPortablePathSegment(value: unknown): value is string {
  return portablePathSegmentError(value) === null;
}
