// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
  detectDefaultCoderRuntimeDrift,
  expectedDefaultCoderRuntimeModel,
  stripDefaultCoderRuntimeMetadata,
} from '../../src/default-coder-drift.js';

describe('default coder drift helpers', () => {
  it('computes the durable default coder runtime/model', () => {
    expect(expectedDefaultCoderRuntimeModel({
      runtime: 'ollama',
      model: 'qwen2.5-coder:7b',
    })).toEqual({
      runtime: 'ollama',
      model: 'qwen2.5-coder:7b',
    });
  });

  it('detects runtime/model drift against the live row', () => {
    const drift = detectDefaultCoderRuntimeDrift(
      { runtime: 'ollama', model: 'qwen2.5-coder:7b' },
      { runtime: 'provider-api', model: 'deepseek/deepseek-r1-0528-qwen3-8b' },
    );

    expect(drift).toEqual({
      runtime: 'ollama',
      model: 'qwen2.5-coder:7b',
      runtimeChanged: true,
      modelChanged: true,
    });
  });

  it('strips provider-runtime-only metadata while preserving unrelated fields', () => {
    expect(stripDefaultCoderRuntimeMetadata({
      alias: 'coder',
      pid: 1234,
      providerRuntime: { lane: 'provider:lmstudio' },
      runtimeCredentialLane: 'provider:lmstudio:default',
      runtimeRateLimit: { laneId: 'provider:lmstudio:default' },
      runtimeRateLimitFailover: { fromLaneId: 'provider:lmstudio:default' },
    })).toEqual({
      alias: 'coder',
      pid: 1234,
    });
  });
});
