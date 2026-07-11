// SPDX-License-Identifier: MIT

import {
  BASE_CHAIN_ID,
  ETHEREUM_CHAIN_ID,
  type ContributorActionPolicyConfig,
  type ContributorChainConfig,
  type ContributorSigningConfig,
} from './types.js';

export interface ContributorSigningConfigIssue {
  path: string;
  message: string;
}

const BASE_ONLY_SURFACES = new Set(['contributor', 'forum']);
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

export function normalizePolicyValue(value: string): string {
  return String(value || '').trim().toLowerCase();
}

export function validateContributorSigningConfig(
  config: ContributorSigningConfig,
): ContributorSigningConfigIssue[] {
  const issues: ContributorSigningConfigIssue[] = [];
  if (!config || typeof config !== 'object') {
    return [{ path: 'contributorSigning', message: 'contributorSigning must be an object' }];
  }
  if (typeof config.enabled !== 'boolean') {
    issues.push({ path: 'contributorSigning.enabled', message: 'enabled must be a boolean' });
  }
  if (!Number.isInteger(config.registryVersion) || config.registryVersion < 1) {
    issues.push({ path: 'contributorSigning.registryVersion', message: 'registryVersion must be a positive integer' });
  }
  if (!Array.isArray(config.chains) || config.chains.length === 0) {
    issues.push({ path: 'contributorSigning.chains', message: 'chains must be a non-empty array' });
    return issues;
  }

  const chainIds = new Set<number>();
  const validChains: ContributorChainConfig[] = [];
  config.chains.forEach((chain, index) => {
    const prefix = `contributorSigning.chains[${index}]`;
    if (!chain || typeof chain !== 'object') {
      issues.push({ path: prefix, message: 'chain must be an object' });
      return;
    }
    validChains.push(chain);
    if (!Number.isInteger(chain.chainId) || chain.chainId <= 0) {
      issues.push({ path: `${prefix}.chainId`, message: 'chainId must be a positive integer' });
    } else if (chainIds.has(chain.chainId)) {
      issues.push({ path: `${prefix}.chainId`, message: `duplicate chainId ${chain.chainId}` });
    } else {
      chainIds.add(chain.chainId);
    }
    if (typeof chain.name !== 'string' || !chain.name.trim()) {
      issues.push({ path: `${prefix}.name`, message: 'name is required' });
    }
    if (typeof chain.rpcEnv !== 'string' || !ENV_NAME.test(chain.rpcEnv)) {
      issues.push({ path: `${prefix}.rpcEnv`, message: 'rpcEnv must name an environment variable, not contain a URL' });
    }
    if (!Array.isArray(chain.scopes) || !chain.scopes.every(scope => typeof scope === 'string' && scope.trim())) {
      issues.push({ path: `${prefix}.scopes`, message: 'scopes must be a non-empty-string array' });
    }
  });

  if (!chainIds.has(BASE_CHAIN_ID)) {
    issues.push({ path: 'contributorSigning.chains', message: 'Base chain 8453 is mandatory' });
  }
  if (!chainIds.has(ETHEREUM_CHAIN_ID)) {
    issues.push({ path: 'contributorSigning.chains', message: 'Ethereum chain 1 must be retained for existing scopes' });
  }

  const base = validChains.find(chain => chain.chainId === BASE_CHAIN_ID);
  for (const scope of BASE_ONLY_SURFACES) {
    if (base && !base.scopes.map(normalizePolicyValue).includes(scope)) {
      issues.push({ path: 'contributorSigning.chains', message: `Base chain 8453 must include ${scope} scope` });
    }
  }
  for (const chain of validChains.filter(chain => chain.chainId !== BASE_CHAIN_ID)) {
    const forbidden = chain.scopes.map(normalizePolicyValue).filter(scope => BASE_ONLY_SURFACES.has(scope));
    if (forbidden.length > 0) {
      issues.push({
        path: `contributorSigning.chains[${config.chains.indexOf(chain)}].scopes`,
        message: `${forbidden.join(', ')} actions are Base-only`,
      });
    }
  }

  if (!Array.isArray(config.policies) || config.policies.length === 0) {
    issues.push({ path: 'contributorSigning.policies', message: 'policies must be a non-empty array' });
    return issues;
  }

  const keys = new Set<string>();
  config.policies.forEach((policy, index) => {
    const prefix = `contributorSigning.policies[${index}]`;
    if (!policy || typeof policy !== 'object') {
      issues.push({ path: prefix, message: 'policy must be an object' });
      return;
    }
    for (const field of ['org', 'surface', 'action'] as const) {
      if (typeof policy[field] !== 'string' || !policy[field].trim()) {
        issues.push({ path: `${prefix}.${field}`, message: `${field} is required` });
      }
    }
    if (!chainIds.has(policy.chainId)) {
      issues.push({ path: `${prefix}.chainId`, message: `chainId ${policy.chainId} is not in the registry` });
    }
    if (BASE_ONLY_SURFACES.has(normalizePolicyValue(policy.surface)) && policy.chainId !== BASE_CHAIN_ID) {
      issues.push({ path: `${prefix}.chainId`, message: `${policy.surface} actions must use Base chain 8453` });
    }
    for (const field of ['allowedTargets', 'allowedRoles'] as const) {
      if (!Array.isArray(policy[field]) || policy[field].length === 0 || !policy[field].every(value => typeof value === 'string' && value.trim())) {
        issues.push({ path: `${prefix}.${field}`, message: `${field} must be a non-empty-string array` });
      }
    }
    const key = policyKey(policy.org, policy.surface, policy.action);
    if (keys.has(key)) issues.push({ path: prefix, message: `duplicate policy ${key}` });
    keys.add(key);
  });

  return issues;
}

function policyKey(org: string, surface: string, action: string): string {
  return [org, surface, action].map(normalizePolicyValue).join(':');
}

export class ContributorChainRegistry {
  private readonly chains = new Map<number, ContributorChainConfig>();
  private readonly policies = new Map<string, ContributorActionPolicyConfig>();

  constructor(
    readonly config: ContributorSigningConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    const issues = validateContributorSigningConfig(config);
    if (issues.length > 0) {
      throw new Error(`Invalid contributor signing config: ${issues.map(issue => `${issue.path}: ${issue.message}`).join('; ')}`);
    }
    for (const chain of config.chains) this.chains.set(chain.chainId, Object.freeze({ ...chain, scopes: [...chain.scopes] }));
    for (const policy of config.policies) this.policies.set(policyKey(policy.org, policy.surface, policy.action), Object.freeze({
      ...policy,
      allowedTargets: [...policy.allowedTargets],
      allowedRoles: [...policy.allowedRoles],
    }));
  }

  getChain(chainId: number): Readonly<ContributorChainConfig> | null {
    return this.chains.get(chainId) || null;
  }

  getPolicy(org: string, surface: string, action: string): Readonly<ContributorActionPolicyConfig> | null {
    return this.policies.get(policyKey(org, surface, action)) || null;
  }

  assertActionChain(org: string, surface: string, action: string, chainId: number): ContributorActionPolicyConfig {
    if (BASE_ONLY_SURFACES.has(normalizePolicyValue(surface)) && chainId !== BASE_CHAIN_ID) {
      throw new Error(`${surface} actions require Base chain 8453`);
    }
    const policy = this.getPolicy(org, surface, action);
    if (!policy) throw new Error('no matching org/surface/action policy');
    if (policy.chainId !== chainId) throw new Error(`action policy requires chain ${policy.chainId}`);
    if (!this.chains.has(chainId)) throw new Error(`chain ${chainId} is not configured`);
    return policy as ContributorActionPolicyConfig;
  }

  resolveRpc(chainId: number, scope: string): string {
    const chain = this.chains.get(chainId);
    if (!chain) throw new Error(`chain ${chainId} is not configured`);
    if (!chain.scopes.map(normalizePolicyValue).includes(normalizePolicyValue(scope))) {
      throw new Error(`chain ${chainId} is not configured for ${scope}`);
    }
    const url = this.env[chain.rpcEnv];
    if (!url) throw new Error(`RPC environment variable ${chain.rpcEnv} is not set`);
    if (!/^https?:\/\//i.test(url)) throw new Error(`RPC environment variable ${chain.rpcEnv} is not an HTTP(S) URL`);
    return url;
  }
}
