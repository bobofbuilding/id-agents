// SPDX-License-Identifier: MIT
/**
 * Compatibility re-export shim.
 *
 * The manager DTO contracts moved to `src/dashboard-core/api/types.ts` so the
 * Electron dashboard can share them. The TUI keeps importing from
 * `./api/types.js`; this file forwards to the renderer-neutral definitions so
 * no call site had to change.
 */

export * from '../../dashboard-core/api/types.js';
