// SPDX-License-Identifier: MIT

import type { AgentSpec } from './config-parser.js';
import type { AgentRow } from './db/types.js';
import type { HarnessType } from './harness/types.js';
import { getDefaultModelForRuntime, resolveRuntime } from './runtime/registry.js';

export interface DefaultCoderRuntimeDrift {
  runtime: HarnessType;
  model: string;
  runtimeChanged: boolean;
  modelChanged: boolean;
}

export function expectedDefaultCoderRuntimeModel(
  coderSpec: Pick<AgentSpec, 'runtime' | 'model'>,
  defaultModel?: string,
): { runtime: HarnessType; model: string } {
  const runtime = resolveRuntime(coderSpec.runtime) as HarnessType;
  return {
    runtime,
    model: coderSpec.model || getDefaultModelForRuntime(runtime, defaultModel),
  };
}

export function detectDefaultCoderRuntimeDrift(
  coderSpec: Pick<AgentSpec, 'runtime' | 'model'>,
  coderRow: Pick<AgentRow, 'runtime' | 'model'>,
  defaultModel?: string,
): DefaultCoderRuntimeDrift | null {
  const desired = expectedDefaultCoderRuntimeModel(coderSpec, defaultModel);
  const runtimeChanged = resolveRuntime(coderRow.runtime as HarnessType) !== desired.runtime;
  const modelChanged = coderRow.model !== desired.model;

  if (!runtimeChanged && !modelChanged) return null;

  return {
    ...desired,
    runtimeChanged,
    modelChanged,
  };
}

export function stripDefaultCoderRuntimeMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const next = { ...(metadata || {}) };
  delete next.providerRuntime;
  delete next.runtimeCredentialLane;
  delete next.runtimeRateLimit;
  delete next.runtimeRateLimitFailover;
  return next;
}
