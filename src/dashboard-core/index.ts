// SPDX-License-Identifier: MIT
/**
 * dashboard-core — renderer-neutral domain layer shared by the id-agents TUI
 * and the Electron dashboard.
 *
 * Commit 2 seeds this package with the manager API surface: DTO contracts,
 * boundary validation, and an injectable client. Later commits extend it with
 * the command policy, formatting, and schedule math already characterized by
 * `tests/unit/dashboard-core-baseline.test.ts`.
 */

export * from './api/types.js';
export * from './api/validation.js';
export * from './api/client.js';

// Commit 3: renderer-neutral display + domain seams.
export * from './formatters/index.js';
export * from './status.js';
export * from './schedule.js';
export * from './selectors/index.js';
