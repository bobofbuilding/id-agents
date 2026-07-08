// SPDX-License-Identifier: MIT

export type RuntimeRateLimitReason =
  | 'subscription_session_cap_unknown_window'
  | 'subscription_daily_cap'
  | 'subscription_weekly_cap'
  | 'subscription_monthly_cap'
  | 'api_rate_limit'
  | 'api_overloaded'
  | 'unknown_rate_limit';

export interface RuntimeRateLimitSignal {
  isRateLimit: true;
  source: 'cli-json-result' | 'cli-stream-event' | 'anthropic-api-headers' | 'text-fallback';
  status?: number;
  reason: RuntimeRateLimitReason;
  resetAt?: string;
  resetText?: string;
  retryAfterSeconds?: number;
  message: string;
}

export interface ClaudeCliExecutionResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

const RESET_RE = /\bresets?\s+([^\n\r.]+)/i;
const TRY_AGAIN_RE = /\btry again at\s+([^\n\r.]+)/i;

function statusOf(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(n) ? n : undefined;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function retryAfterSecondsOf(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function classify(text: string): RuntimeRateLimitReason {
  return /\bmonthly\b/i.test(text)
    ? 'subscription_monthly_cap'
    : /\bweekly\b/i.test(text)
    ? 'subscription_weekly_cap'
    : /\bdaily\b/i.test(text)
    ? 'subscription_daily_cap'
    : /session limit/i.test(text)
    ? 'subscription_session_cap_unknown_window'
    : /usage limit|codex\/settings\/usage/i.test(text)
    ? 'subscription_monthly_cap'
    : 'unknown_rate_limit';
}

function reasonFor(status: number | undefined, errorType: string, message: string): RuntimeRateLimitReason {
  if (status === 529 || errorType === 'overloaded_error') return 'api_overloaded';
  if (status === 429 && !/session limit|weekly/i.test(message)) return 'api_rate_limit';
  return classify(message);
}

function resetTextFrom(text: string): string | undefined {
  const match = text.match(RESET_RE) || text.match(TRY_AGAIN_RE);
  return match?.[1]?.trim();
}

function resetAtFromText(text: string): string | undefined {
  const resetText = resetTextFrom(text);
  if (!resetText) return undefined;
  const normalized = resetText
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function signal(
  source: RuntimeRateLimitSignal['source'],
  status: number | undefined,
  message: string,
  options: { errorType?: string; retryAfterSeconds?: number; resetAt?: string } = {},
): RuntimeRateLimitSignal {
  return {
    isRateLimit: true,
    source,
    status,
    reason: reasonFor(status, options.errorType || '', message),
    ...((options.resetAt || resetAtFromText(message)) && options.retryAfterSeconds === undefined ? { resetAt: options.resetAt || resetAtFromText(message) } : {}),
    ...(options.retryAfterSeconds !== undefined ? { retryAfterSeconds: options.retryAfterSeconds } : {}),
    resetText: resetTextFrom(message),
    message,
  };
}

function inspectJsonObject(obj: any, source: RuntimeRateLimitSignal['source']): RuntimeRateLimitSignal | null {
  if (!obj || typeof obj !== 'object') return null;

  const status = statusOf(obj.api_error_status ?? obj.apiErrorStatus ?? obj.status ?? obj.statusCode);
  const nestedError = objectOf(obj.error);
  const error = textOf(obj.error);
  const errorType = textOf(nestedError?.type) || error;
  const errorMessage = textOf(nestedError?.message);
  const result = textOf(obj.result);
  const message = textOf(obj.message);
  const retryAfterSeconds = retryAfterSecondsOf(
    obj.retry_after ?? obj.retryAfter ?? obj.retry_after_seconds ?? obj.retryAfterSeconds,
  );
  const combined = [errorMessage, result, message, error && error !== errorType ? error : ''].filter(Boolean).join('\n');

  if (status === 429 || status === 529) {
    return signal(source, status, combined || `Claude CLI returned HTTP ${status}`, { errorType, retryAfterSeconds });
  }

  if (errorType === 'rate_limit' || errorType === 'rate_limit_error' || errorType === 'overloaded_error') {
    return signal(source, status, combined || `Claude CLI stream event reported ${errorType}`, { errorType, retryAfterSeconds });
  }

  return null;
}

function inspectJsonLines(stdout: string): RuntimeRateLimitSignal | null {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const found = inspectJsonObject(parsed, parsed.type && parsed.type !== 'result' ? 'cli-stream-event' : 'cli-json-result');
      if (found) return found;
    } catch {
      // Ignore non-JSON noise; the CLI can mix progress text into output.
    }
  }
  return null;
}

export function detectClaudeCliRateLimit(result: ClaudeCliExecutionResult): RuntimeRateLimitSignal | null {
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  const jsonSignal = inspectJsonLines(stdout);
  if (jsonSignal) return jsonSignal;

  const text = `${stdout}\n${stderr}`;
  if (/You've hit your (session|usage) limit/i.test(text) || /chatgpt\.com\/codex\/settings\/usage/i.test(text)) {
    return signal('text-fallback', undefined, text.trim().slice(0, 1000));
  }

  return null;
}

export function detectAnthropicHeaderRateLimit(headers: Record<string, string | string[] | undefined>, status?: number): RuntimeRateLimitSignal | null {
  if (status !== 429 && status !== 529) return null;
  const lower = new Map<string, string>();
  for (const [key, value] of Object.entries(headers || {})) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') lower.set(key.toLowerCase(), first);
  }
  const retryAfterSeconds = retryAfterSecondsOf(lower.get('retry-after'));
  const reset = lower.get('anthropic-ratelimit-requests-reset')
    || lower.get('anthropic-ratelimit-tokens-reset')
    || lower.get('anthropic-ratelimit-input-tokens-reset')
    || lower.get('anthropic-ratelimit-output-tokens-reset');
  if (!reset && retryAfterSeconds === undefined && status !== 529) return null;
  const reason: RuntimeRateLimitReason = status === 529 ? 'api_overloaded' : 'api_rate_limit';
  const message = retryAfterSeconds !== undefined
    ? `Anthropic API ${status === 529 ? 'overload' : 'rate limit'} retry after ${retryAfterSeconds} seconds`
    : reset
    ? `Anthropic API rate limit resets at ${reset}`
    : 'Anthropic API overloaded';
  return {
    isRateLimit: true,
    source: 'anthropic-api-headers',
    status,
    reason,
    ...(reset && retryAfterSeconds === undefined ? { resetAt: reset } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    message,
  };
}
