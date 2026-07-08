import { describe, expect, it } from 'vitest';

import { endpoint } from '../../src/harness/provider-api.js';

describe('provider API endpoint construction', () => {
  it('maps native Ollama bases to the OpenAI-compatible v1 endpoint', () => {
    expect(endpoint('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(endpoint('http://localhost:11434/')).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('preserves explicit OpenAI-compatible provider bases and endpoints', () => {
    expect(endpoint('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(endpoint('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(endpoint('https://example.test/v1/chat/completions')).toBe('https://example.test/v1/chat/completions');
  });
});
