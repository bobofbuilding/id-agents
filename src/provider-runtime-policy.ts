// SPDX-License-Identifier: MIT

/**
 * Provider runtime assignments may carry an API credential from the Manager
 * process into a provider worker. Keep that authority deliberately narrow:
 * only reviewed model-provider variables may be referenced, and credentials
 * may travel only to HTTPS endpoints or exact loopback HTTP endpoints.
 */

export interface ProviderRuntimePolicyInput {
  lane: string;
  name: string;
  kind?: string;
  baseUrl: string;
  keyEnv?: string;
  apiKey?: string;
}

const PROVIDER_KEY_ENV_NAMES = new Set([
  'ID_PROVIDER_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'CEREBRAS_API_KEY',
  'COHERE_API_KEY',
  'DEEPSEEK_API_KEY',
  'FIREWORKS_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'NEBIUS_API_KEY',
  'NVIDIA_API_KEY',
  'NVIDIA_NIM_API_KEY',
  'NVAPI_KEY',
  'PERPLEXITY_API_KEY',
  'SAMBANOVA_API_KEY',
  'TOGETHER_API_KEY',
  'XAI_API_KEY',
]);

function invalidControlText(value: string): boolean {
  return /[\0-\x1f\x7f]/.test(value);
}

export function normalizeProviderCredentialEnv(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || raw !== raw.trim() || !PROVIDER_KEY_ENV_NAMES.has(raw)) {
    throw new Error('provider runtime keyEnv is not an approved model-provider credential');
  }
  return raw;
}

export function normalizeProviderBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw !== raw.trim() || !raw) {
    throw new Error('provider runtime lane requires baseUrl');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('provider runtime baseUrl must be an absolute URL');
  }
  if (
    url.username
    || url.password
    || url.hash
    || url.search
  ) {
    throw new Error('provider runtime baseUrl cannot contain credentials, a query, or a fragment');
  }
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '[::1]'
    || hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('provider runtime baseUrl must use HTTPS or exact loopback HTTP');
  }
  return url.toString().replace(/\/+$/, '');
}

export function normalizeProviderRuntimePolicy(
  input: ProviderRuntimePolicyInput,
  options: { allowInlineApiKey?: boolean } = {},
): ProviderRuntimePolicyInput {
  if (
    typeof input.lane !== 'string'
    || !input.lane.startsWith('provider:')
    || input.lane.length > 256
    || invalidControlText(input.lane)
  ) {
    throw new Error('provider runtime lane must be provider:<name>');
  }
  const name = String(input.name || '').trim();
  if (!name || name.length > 128 || invalidControlText(name)) {
    throw new Error('provider runtime name must be 1-128 printable characters');
  }
  const kind = input.kind === undefined ? undefined : String(input.kind).trim();
  if (kind !== undefined && (!kind || kind.length > 64 || invalidControlText(kind))) {
    throw new Error('provider runtime kind must be 1-64 printable characters');
  }
  const keyEnv = normalizeProviderCredentialEnv(input.keyEnv);
  const apiKey = input.apiKey === undefined ? undefined : String(input.apiKey);
  if (apiKey !== undefined) {
    if (
      options.allowInlineApiKey !== true
      || !apiKey
      || apiKey.length > 16_384
      || invalidControlText(apiKey)
    ) {
      throw new Error('provider runtime apiKey is not permitted in this assignment');
    }
  }
  return {
    lane: input.lane,
    name,
    ...(kind ? { kind } : {}),
    baseUrl: normalizeProviderBaseUrl(input.baseUrl),
    ...(keyEnv ? { keyEnv } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}
