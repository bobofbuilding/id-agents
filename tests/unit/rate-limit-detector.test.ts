// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import { detectAnthropicHeaderRateLimit, detectClaudeCliRateLimit } from '../../src/harness/rate-limit.js';

describe('Claude CLI rate-limit detector', () => {
  it('detects JSON result HTTP 429 on stdout', () => {
    const found = detectClaudeCliRateLimit({
      exitCode: 1,
      stdout: JSON.stringify({
        is_error: true,
        api_error_status: 429,
        result: "You've hit your session limit · resets 10:40am (Europe/Lisbon)",
      }),
      stderr: '',
    });

    expect(found).toMatchObject({
      source: 'cli-json-result',
      status: 429,
      reason: 'subscription_session_cap_unknown_window',
      resetText: '10:40am (Europe/Lisbon)',
    });
  });

  it('detects stream/transcript rate_limit events with apiErrorStatus', () => {
    const found = detectClaudeCliRateLimit({
      stdout: [
        JSON.stringify({ type: 'system', message: 'start' }),
        JSON.stringify({
          type: 'error',
          error: 'rate_limit',
          apiErrorStatus: 429,
          message: "You've hit your session limit · resets 10:40am (Europe/Lisbon)",
        }),
      ].join('\n'),
    });

    expect(found).toMatchObject({
      source: 'cli-stream-event',
      status: 429,
      reason: 'subscription_session_cap_unknown_window',
    });
  });

  it('detects nested Anthropic API rate_limit_error bodies', () => {
    const found = detectClaudeCliRateLimit({
      exitCode: 1,
      stdout: JSON.stringify({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'Requests exceeded. Try again later.',
        },
        api_error_status: 429,
      }),
      stderr: '',
    });

    expect(found).toMatchObject({
      source: 'cli-stream-event',
      status: 429,
      reason: 'api_rate_limit',
      message: 'Requests exceeded. Try again later.',
    });
  });

  it('detects nested Anthropic API overloaded_error bodies as HTTP 529', () => {
    const found = detectClaudeCliRateLimit({
      exitCode: 1,
      stdout: JSON.stringify({
        type: 'error',
        error: {
          type: 'overloaded_error',
          message: 'Overloaded',
        },
        api_error_status: 529,
      }),
      stderr: '',
    });

    expect(found).toMatchObject({
      source: 'cli-stream-event',
      status: 529,
      reason: 'api_overloaded',
      message: 'Overloaded',
    });
  });

  it('surfaces retry-after fields from structured CLI JSON as seconds', () => {
    const found = detectClaudeCliRateLimit({
      exitCode: 1,
      stdout: JSON.stringify({
        is_error: true,
        api_error_status: 429,
        retry_after: '17',
        error: {
          type: 'rate_limit_error',
          message: 'Too many requests',
        },
      }),
      stderr: '',
    });

    expect(found).toMatchObject({
      status: 429,
      reason: 'api_rate_limit',
      retryAfterSeconds: 17,
    });
  });

  it('detects confirmed session-limit text as the only text fallback', () => {
    const found = detectClaudeCliRateLimit({
      stdout: '',
      stderr: "You've hit your session limit · resets 10:40am (Europe/Lisbon)",
    });

    expect(found).toMatchObject({
      source: 'text-fallback',
      reason: 'subscription_session_cap_unknown_window',
    });
  });

  it('detects Codex usage-limit text as a subscription cap', () => {
    const found = detectClaudeCliRateLimit({
      stdout: '',
      stderr: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jul 10th, 2026 6:40 PM.",
    });

    expect(found).toMatchObject({
      source: 'text-fallback',
      reason: 'subscription_monthly_cap',
      resetAt: expect.any(String),
    });
  });

  it('does not match bare rate_limit text outside structured events', () => {
    expect(detectClaudeCliRateLimit({
      stdout: '',
      stderr: 'rate_limit: something failed',
    })).toBeNull();
  });

  it('does not classify generic process failures as rate limits', () => {
    expect(detectClaudeCliRateLimit({
      exitCode: 1,
      stdout: '',
      stderr: 'Claude CLI exited with code 1',
    })).toBeNull();
  });
});

describe('Anthropic API header rate-limit detector', () => {
  it('requires HTTP 429 plus a reset header', () => {
    expect(detectAnthropicHeaderRateLimit({
      'anthropic-ratelimit-requests-reset': '2026-06-26T16:45:00Z',
    }, 429)).toMatchObject({
      source: 'anthropic-api-headers',
      status: 429,
      resetAt: '2026-06-26T16:45:00Z',
    });
  });

  it('prefers retry-after seconds over Anthropic reset headers', () => {
    expect(detectAnthropicHeaderRateLimit({
      'retry-after': '42',
      'anthropic-ratelimit-requests-reset': '2026-06-26T16:45:00Z',
    }, 429)).toMatchObject({
      source: 'anthropic-api-headers',
      status: 429,
      reason: 'api_rate_limit',
      retryAfterSeconds: 42,
    });
    expect(detectAnthropicHeaderRateLimit({
      'retry-after': '42',
      'anthropic-ratelimit-requests-reset': '2026-06-26T16:45:00Z',
    }, 429)).not.toHaveProperty('resetAt');
  });

  it('detects HTTP 529 overload responses from status alone', () => {
    expect(detectAnthropicHeaderRateLimit({}, 529)).toMatchObject({
      source: 'anthropic-api-headers',
      status: 529,
      reason: 'api_overloaded',
    });
  });

  it('ignores 429s without Anthropic reset headers', () => {
    expect(detectAnthropicHeaderRateLimit({}, 429)).toBeNull();
  });
});
