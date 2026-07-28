// SPDX-License-Identifier: MIT

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentManagerDb,
  reusableYamlDeployPort,
  stableYamlRedeployAgentId,
} from '../../src/agent-manager-db.js';
import { diffAgent } from '../../src/sync.js';

const ENV_KEYS = [
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'TEMP',
  'TMP',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'CLAUDE_PATH',
  'ID_AGENT_CODEX_BIN',
  'CODEX_BIN',
  'CODEX_EXECUTABLE',
  'SQLITE_PATH',
  'DATABASE_URL',
  'ID_WORKSPACE_DIR',
  'WORKSPACE_DIR',
  'IDACC_MANAGED_SERVICE',
  'IDACC_DATA_DIR',
  'CODEX_HOME',
  'XMTP_ENV',
  'XMTP_WALLET_KEY',
  'XMTP_DB_ENCRYPTION_KEY',
  'XMTP_DB_DIRECTORY',
] as const;

describe('Manager worker environment portability', () => {
  const workDirs: string[] = [];
  const originals = new Map<string, string | undefined>();

  afterEach(() => {
    for (const [key, value] of originals) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originals.clear();
    for (const dir of workDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the immutable agent id across same-name YAML redeploys', () => {
    expect(stableYamlRedeployAgentId(
      { id: 'agent-existing-stable' },
      'agent-new-random',
    )).toBe('agent-existing-stable');
    expect(stableYamlRedeployAgentId(null, 'agent-new-random'))
      .toBe('agent-new-random');
    expect(reusableYamlDeployPort(43123)).toBe(43123);
    expect(reusableYamlDeployPort(0)).toBeNull();
    expect(reusableYamlDeployPort(65_536)).toBeNull();
    expect(reusableYamlDeployPort(null)).toBeNull();
  });

  it('deep-redacts provider credentials while retaining the public identity key', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-redaction-'));
    workDirs.push(workDir);
    const manager = new AgentManagerDb(workDir, {} as any, { libraryRoot: null }) as any;
    const redacted = manager.redactForNonAdmin({
      metadata: {
        identityKey: 'worker-v1',
        safeField: 'visible',
        skillmesh_private_key: 'private-secret',
        skillmesh_creator_key: 'creator-secret',
        accessToken: 'access-secret',
        providers: {
          apiKey: 'provider-secret',
          auth: { token: 'nested-secret' },
          headers: {
            Authorization: 'Bearer hidden',
            'X-API-Key': 'header-secret',
          },
          baseUrl: 'https://provider.example.test',
        },
      },
    });

    expect(redacted.metadata).toEqual({
      identityKey: 'worker-v1',
      safeField: 'visible',
      providers: {
        baseUrl: 'https://provider.example.test',
      },
    });
  });

  it('propagates declarative env, identity, tools, plugins, and XMTP policy to local workers', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-worker-declarative-env-'));
    workDirs.push(workDir);
    const manager = new AgentManagerDb(workDir, {} as any, { libraryRoot: null }) as any;
    const agent = {
      id: 'agent-stable-id',
      name: 'worker.xid.eth',
      domain: 'worker.xid.eth',
      runtime: 'codex',
      token_id: 'token-id',
      port: 43123,
      metadata: {
        name: 'renamed-worker',
        alias: 'renamed-worker',
        idchain_domain: 'worker.xid.eth',
        env: {
          APP_FEATURE_FLAG: 'enabled',
          CUSTOM_TOKEN: 'agent-token',
          ID_AGENT_ID: 'attacker-id',
          MANAGER_URL: 'http://attacker.invalid',
          OPENAI_API_KEY: 'attacker-runtime-key',
          aNtHrOpIc_BaSe_Url: 'https://attacker.invalid',
          Http_Proxy: 'http://attacker.invalid:8080',
          node_extra_ca_certs: '/attacker/ca.pem',
          Node_Tls_Reject_Unauthorized: '0',
          sslKeyLogFile: '/attacker/session-keys.log',
          ld_library_path: '/attacker/lib',
          Ld_Audit: '/attacker/audit.so',
          provider_api_base_url: 'https://attacker.invalid',
          XMTP_OPEN_MODE: 'false',
        },
        allowed_tools: ['Read', 'Grep'],
        openMode: true,
        plugins: [{
          name: 'consumer-plugin',
          path: '/profile/workspaces/worker/plugins/consumer-plugin',
        }],
      },
    };

    const localEnv = manager.buildLocalAgentEnv(
      'team-id',
      'default',
      43123,
      agent,
    );
    expect(localEnv.APP_FEATURE_FLAG).toBe('enabled');
    expect(localEnv.CUSTOM_TOKEN).toBe('agent-token');
    expect(localEnv.ID_AGENT_ID).toBe('agent-stable-id');
    expect(localEnv.ID_AGENT_NAME).toBe('worker.xid.eth');
    expect(localEnv.ID_AGENT_ALIAS).toBe('renamed-worker');
    expect(JSON.parse(localEnv.ID_AGENT_ALLOWED_TOOLS)).toEqual(['Read', 'Grep']);
    expect(JSON.parse(localEnv.ID_PLUGINS)).toEqual(agent.metadata.plugins);
    expect(localEnv.XMTP_OPEN_MODE).toBe('true');
    expect(localEnv.MANAGER_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(localEnv.OPENAI_API_KEY).not.toBe('attacker-runtime-key');
    expect(localEnv.aNtHrOpIc_BaSe_Url).toBeUndefined();
    expect(localEnv.Http_Proxy).toBeUndefined();
    expect(localEnv.node_extra_ca_certs).toBeUndefined();
    expect(localEnv.Node_Tls_Reject_Unauthorized).toBeUndefined();
    expect(localEnv.sslKeyLogFile).toBeUndefined();
    expect(localEnv.ld_library_path).toBeUndefined();
    expect(localEnv.Ld_Audit).toBeUndefined();
    expect(localEnv.provider_api_base_url).toBeUndefined();

    const workerEnv = manager.buildWorkerEnv('team-id', 'default', agent);
    expect(workerEnv.APP_FEATURE_FLAG).toBe('enabled');
    expect(workerEnv.ID_AGENT_ID).toBeUndefined();
    expect(workerEnv.ID_DB_AGENT_ID).toBe('agent-stable-id');
    expect(workerEnv.ID_AGENT_NAME).toBe('worker.xid.eth');
    expect(workerEnv.ID_AGENT_ALIAS).toBe('renamed-worker');
    expect(JSON.parse(workerEnv.ID_AGENT_ALLOWED_TOOLS)).toEqual(['Read', 'Grep']);
    expect(JSON.parse(workerEnv.ID_PLUGINS)).toEqual(agent.metadata.plugins);
    expect(workerEnv.XMTP_OPEN_MODE).toBe('true');
    expect(workerEnv.MANAGER_URL).toBeUndefined();
    expect(workerEnv.OPENAI_API_KEY).toBeUndefined();
  });

  it('detects removal and explicit false changes for YAML-owned security metadata', () => {
    const row = {
      team_id: 'team-id',
      id: 'agent-id',
      name: 'worker',
      type: 'claude',
      model: 'gpt-5',
      port: 43123,
      endpoint: 'http://localhost:43123',
      working_directory: '/profile/workspaces/worker',
      status: 'running',
      created_at: 1,
      registry: null,
      metadata: {
        runtime: 'codex',
        openMode: true,
        dangerouslySkipPermissions: false,
        mcpServers: [{ name: 'legacy', transport: 'stdio', command: 'legacy-mcp' }],
        wallet: false,
        ows_wallet: 'stale-wallet-that-must-be-stripped',
      },
      deleted_at: null,
      runtime: 'codex',
      token_id: 'retained-token',
      domain: 'worker.example.eth',
      api_key: null,
    } as any;

    const changes = diffAgent({
      name: 'worker',
      runtime: 'codex',
      model: 'gpt-5',
      wallet: false,
    }, row);

    expect(changes).toEqual(expect.arrayContaining([
      'mcpServers',
      'wallet',
      'openMode',
      'dangerouslySkipPermissions',
    ]));
    expect(changes).not.toContain('domain');
    expect(changes).not.toContain('tokenId');
  });

  it('preserves Windows runtime variables and desktop-resolved CLI paths', () => {
    // Create the fixture before overriding TEMP/TMP. On Windows os.tmpdir()
    // reads those variables, and the synthetic C:\ paths do not exist on CI.
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-worker-env-'));
    workDirs.push(workDir);
    const windows = path.win32;
    const consumerHome = windows.join('C:\\', 'Users', 'consumer');
    const consumerLocalAppData = windows.join(consumerHome, 'AppData', 'Local');
    const consumerRoamingAppData = windows.join(consumerHome, 'AppData', 'Roaming');
    const profileDataDir = windows.join(
      consumerRoamingAppData,
      'IDACC',
      'profiles',
      'default',
    );
    const values: Record<(typeof ENV_KEYS)[number], string> = {
      APPDATA: consumerRoamingAppData,
      LOCALAPPDATA: consumerLocalAppData,
      USERPROFILE: consumerHome,
      TEMP: windows.join(consumerLocalAppData, 'Temp'),
      TMP: windows.join(consumerLocalAppData, 'Temp'),
      SystemRoot: windows.join('C:\\', 'Windows'),
      ComSpec: windows.join('C:\\', 'Windows', 'System32', 'cmd.exe'),
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      CLAUDE_PATH: windows.join(consumerRoamingAppData, 'npm', 'claude.cmd'),
      ID_AGENT_CODEX_BIN: windows.join(consumerRoamingAppData, 'npm', 'codex.cmd'),
      CODEX_BIN: windows.join('C:\\', 'standalone', 'codex-bin.cmd'),
      CODEX_EXECUTABLE: windows.join('C:\\', 'standalone', 'codex-executable.cmd'),
      SQLITE_PATH: windows.join(profileDataDir, 'manager.sqlite'),
      DATABASE_URL: 'postgresql://manager.example/idagents',
      ID_WORKSPACE_DIR: windows.join(profileDataDir, 'workspace'),
      WORKSPACE_DIR: windows.join('C:\\', 'legacy-workspace-that-must-not-win'),
      IDACC_MANAGED_SERVICE: '1',
      IDACC_DATA_DIR: profileDataDir,
      CODEX_HOME: windows.join(consumerHome, '.custom-codex'),
      XMTP_ENV: 'dev',
      XMTP_WALLET_KEY: 'must-not-cross-worker-boundary',
      XMTP_DB_ENCRYPTION_KEY: 'must-not-cross-worker-boundary',
      XMTP_DB_DIRECTORY: windows.join('C:\\', 'legacy-xmtp-state'),
    };
    for (const key of ENV_KEYS) {
      originals.set(key, process.env[key]);
      process.env[key] = values[key];
    }

    const manager = new AgentManagerDb(workDir, {} as any, { libraryRoot: null }) as any;
    const env = manager.buildLocalAgentEnv(
      'team-id',
      'default',
      43123,
      { id: 'agent-stable-id', runtime: 'claude-code-cli', metadata: {} },
    );

    for (const key of ENV_KEYS) {
      if (
        key === 'SQLITE_PATH'
        || key === 'WORKSPACE_DIR'
        || key === 'CODEX_HOME'
        || key === 'XMTP_WALLET_KEY'
        || key === 'XMTP_DB_ENCRYPTION_KEY'
        || key === 'XMTP_DB_DIRECTORY'
      ) {
        expect(env[key]).toBeUndefined();
      } else {
        expect(env[key]).toBe(values[key]);
      }
    }
    expect(env.ID_AGENT_ID).toBe('agent-stable-id');
  });

  it('prevents hostile credential-lane env from overriding the managed worker envelope', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-worker-lane-env-'));
    workDirs.push(workDir);
    const profileDataDir = path.join(workDir, 'profiles', 'default');
    const profileWorkspace = path.join(profileDataDir, 'workspace');
    const profileSqlite = path.join(profileDataDir, 'manager.sqlite');
    const providerHome = path.join(workDir, 'operator', 'codex-provider');
    for (const key of ENV_KEYS) originals.set(key, process.env[key]);
    for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES']) {
      originals.set(key, process.env[key]);
      delete process.env[key];
    }
    delete process.env.CODEX_BIN;
    process.env.IDACC_MANAGED_SERVICE = '1';
    process.env.IDACC_DATA_DIR = profileDataDir;
    process.env.ID_WORKSPACE_DIR = profileWorkspace;
    process.env.SQLITE_PATH = profileSqlite;
    process.env.CODEX_HOME = providerHome;
    process.env.XMTP_ENV = 'dev';

    const manager = new AgentManagerDb(workDir, {} as any, { libraryRoot: null }) as any;
    manager.runtimeCredentialPoolByTeam.set('team-id', {
      lanes: [{
        id: 'hostile-lane',
        runtime: 'codex',
        kind: 'subscription',
        env: {
          CUSTOM_PROVIDER_TOKEN: 'unreviewed-credential',
          OPENAI_API_KEY: 'wrong-kind-key',
          OPENAI_ORGANIZATION: 'attacker-org',
          ANTHROPIC_CUSTOM_HEADERS: 'x-attacker: true',
          OLLAMA_HOST: 'http://attacker.invalid',
          PROVIDER_API_TOKEN: 'attacker-provider-token',
          oPeNaI_aPi_kEy: 'mixed-case-key',
          CUSTOM_OBJECT: { unsafe: true },
          IDACC_DATA_DIR: '/attacker/profile',
          ID_AGENT_ID: 'attacker-id',
          ID_MCP_SERVERS: '[{"name":"attacker"}]',
          ID_PLUGINS: '["attacker-plugin"]',
          ID_RUNTIME_LANE_ID: 'attacker-lane',
          ID_WORKSPACE_DIR: '/attacker/workspace',
          idAcc_instance_nonce: 'attacker-instance',
          SQLITE_PATH: '/attacker/manager.sqlite',
          DATABASE_URL: 'postgresql://attacker.invalid/manager',
          CODEX_HOME: '/attacker/codex',
          MANAGER_URL: 'http://attacker.invalid',
          OWS_WALLET: 'attacker-wallet',
          oWs_Private_Key: 'attacker-ows-key',
          PRIVATE_KEY: 'attacker-private-key',
          skillMesh_Private_Key: 'attacker-skillmesh-key',
          XMTP_ENV: 'production',
          XMTP_WALLET_KEY: 'attacker-wallet-key',
          XMTP_DB_ENCRYPTION_KEY: 'attacker-db-key',
          XMTP_DB_DIRECTORY: '/attacker/xmtp',
          CODEX_BIN: '/attacker/codex',
          codex_home: '/attacker/lowercase-codex',
          Path: '/attacker/bin',
          LANG: 'attacker-locale',
          ProgramFiles: 'C:\\attacker\\programs',
          CLAUDE_CODE_OAUTH_TOKEN: 'attacker-session-token',
          NODE_OPTIONS: '--require=/attacker/preload.cjs',
          DYLD_INSERT_LIBRARIES: '/attacker/preload.dylib',
          Ld_Library_Path: '/attacker/lib',
          lD_AuDiT: '/attacker/audit.so',
          Http_Proxy: 'http://attacker.invalid:8080',
          hTtPs_PrOxY: 'http://attacker.invalid:8443',
          node_extra_ca_certs: '/attacker/ca.pem',
          Node_Tls_Reject_Unauthorized: '0',
          sslKeyLogFile: '/attacker/session-keys.log',
          SSL_CERT_FILE: '/attacker/cert.pem',
          OpenAi_Base_Url: 'https://attacker.invalid',
        },
      }],
    });

    const env = manager.buildLocalAgentEnv(
      'team-id',
      'default',
      43140,
      {
        id: 'stable-agent-id',
        runtime: 'codex',
        metadata: { runtimeCredentialLane: 'hostile-lane' },
      },
    );

    expect(env.CUSTOM_PROVIDER_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_ORGANIZATION).toBeUndefined();
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(env.OLLAMA_HOST).toBeUndefined();
    expect(env.PROVIDER_API_TOKEN).toBeUndefined();
    expect(env.oPeNaI_aPi_kEy).toBeUndefined();
    expect(env.CUSTOM_OBJECT).toBeUndefined();
    expect(env.IDACC_DATA_DIR).toBe(profileDataDir);
    expect(env.ID_AGENT_ID).toBe('stable-agent-id');
    expect(env.ID_MCP_SERVERS).toBeUndefined();
    expect(env.ID_PLUGINS).toBeUndefined();
    expect(env.ID_RUNTIME_LANE_ID).toBe('hostile-lane');
    expect(env.ID_WORKSPACE_DIR).toBe(profileWorkspace);
    expect(env.idAcc_instance_nonce).toBeUndefined();
    expect(env.SQLITE_PATH).toBe(profileSqlite);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.CODEX_HOME).toBe(providerHome);
    expect(env.MANAGER_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(env.OWS_WALLET).toBeUndefined();
    expect(env.oWs_Private_Key).toBeUndefined();
    expect(env.PRIVATE_KEY).toBeUndefined();
    expect(env.skillMesh_Private_Key).toBeUndefined();
    expect(env.XMTP_ENV).toBe('dev');
    expect(env.XMTP_WALLET_KEY).toBeUndefined();
    expect(env.XMTP_DB_ENCRYPTION_KEY).toBeUndefined();
    expect(env.XMTP_DB_DIRECTORY).toBeUndefined();
    expect(env.CODEX_BIN).toBeUndefined();
    expect(env.codex_home).toBeUndefined();
    expect(env.Path).toBeUndefined();
    expect(env.LANG).not.toBe('attacker-locale');
    expect(env.ProgramFiles).not.toBe('C:\\attacker\\programs');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).not.toContain('/attacker/preload.cjs');
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(env.Ld_Library_Path).toBeUndefined();
    expect(env.lD_AuDiT).toBeUndefined();
    expect(env.Http_Proxy).toBeUndefined();
    expect(env.hTtPs_PrOxY).toBeUndefined();
    expect(env.node_extra_ca_certs).toBeUndefined();
    expect(env.Node_Tls_Reject_Unauthorized).toBeUndefined();
    expect(env.sslKeyLogFile).toBeUndefined();
    expect(env.SSL_CERT_FILE).toBeUndefined();
    expect(env.OpenAi_Base_Url).toBeUndefined();
  });

  it('injects provider API keys only from the selected exact credential lane', () => {
    originals.set('OPENAI_API_KEY', process.env.OPENAI_API_KEY);
    originals.set('ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY);
    originals.set('CLAUDE_API_KEY', process.env.CLAUDE_API_KEY);
    process.env.OPENAI_API_KEY = 'manager-global-openai-key';
    process.env.ANTHROPIC_API_KEY = 'manager-global-anthropic-key';
    process.env.CLAUDE_API_KEY = 'manager-unreviewed-claude-key';

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-worker-exact-lanes-'));
    workDirs.push(workDir);
    const manager = new AgentManagerDb(workDir, {} as any, { libraryRoot: null }) as any;

    manager.runtimeCredentialPoolByTeam.set('codex-subscription-team', {
      lanes: [{
        id: 'codex-subscription',
        runtime: 'codex',
        kind: 'subscription',
        env: { OPENAI_API_KEY: 'must-be-rejected' },
      }],
    });
    const codexSubscription = manager.buildLocalAgentEnv(
      'codex-subscription-team',
      'default',
      43141,
      {
        id: 'codex-subscription-agent',
        runtime: 'codex',
        metadata: { runtimeCredentialLane: 'codex-subscription' },
      },
    );
    expect(codexSubscription.OPENAI_API_KEY).toBeUndefined();
    expect(codexSubscription.ANTHROPIC_API_KEY).toBeUndefined();
    expect(codexSubscription.CLAUDE_API_KEY).toBeUndefined();

    manager.runtimeCredentialPoolByTeam.set('sdk-subscription-team', {
      lanes: [{
        id: 'sdk-subscription',
        runtime: 'claude-agent-sdk',
        kind: 'subscription',
        env: { ANTHROPIC_API_KEY: 'must-be-rejected' },
      }],
    });
    const sdkSubscription = manager.buildLocalAgentEnv(
      'sdk-subscription-team',
      'default',
      43144,
      {
        id: 'sdk-subscription-agent',
        runtime: 'claude-agent-sdk',
        metadata: { runtimeCredentialLane: 'sdk-subscription' },
      },
    );
    expect(sdkSubscription.ANTHROPIC_API_KEY).toBeUndefined();
    expect(sdkSubscription.OPENAI_API_KEY).toBeUndefined();

    manager.runtimeCredentialPoolByTeam.set('claude-metered-team', {
      lanes: [{
        id: 'claude-metered',
        runtime: 'claude-code-cli',
        kind: 'metered-api',
        env: { ANTHROPIC_API_KEY: 'selected-anthropic-key' },
      }],
    });
    const claudeMetered = manager.buildLocalAgentEnv(
      'claude-metered-team',
      'default',
      43142,
      {
        id: 'claude-metered-agent',
        runtime: 'claude-code-cli',
        metadata: { runtimeCredentialLane: 'claude-metered' },
      },
    );
    expect(claudeMetered.ANTHROPIC_API_KEY).toBe('selected-anthropic-key');
    expect(claudeMetered.OPENAI_API_KEY).toBeUndefined();
    expect(claudeMetered.CLAUDE_API_KEY).toBeUndefined();

    manager.runtimeCredentialPoolByTeam.set('codex-metered-team', {
      lanes: [{
        id: 'codex-metered',
        runtime: 'codex',
        kind: 'metered-api',
        env: { OPENAI_API_KEY: 'selected-codex-key' },
      }],
    });
    const codexMetered = manager.buildLocalAgentEnv(
      'codex-metered-team',
      'default',
      43143,
      {
        id: 'codex-metered-agent',
        runtime: 'codex',
        metadata: { runtimeCredentialLane: 'codex-metered' },
      },
    );
    expect(codexMetered.OPENAI_API_KEY).toBe('selected-codex-key');
    expect(codexMetered.ANTHROPIC_API_KEY).toBeUndefined();
    expect(codexMetered.CLAUDE_API_KEY).toBeUndefined();
  });

  it('quarantines hostile persisted provider runtime metadata and cannot read Manager secrets by keyEnv', () => {
    for (const key of ['BRAIN_TOKEN', 'DATABASE_URL', 'OPENROUTER_API_KEY']) {
      originals.set(key, process.env[key]);
    }
    process.env.BRAIN_TOKEN = 'manager-brain-secret';
    process.env.DATABASE_URL = 'postgresql://manager-secret';
    process.env.OPENROUTER_API_KEY = 'reviewed-provider-key';

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-worker-provider-policy-'));
    workDirs.push(workDir);
    const manager = new AgentManagerDb(workDir, {} as any, { libraryRoot: null }) as any;
    expect(manager.normalizeProviderRuntimeAssignment('provider:openrouter', {
      name: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'process-local-provider-key',
      keyEnv: 'IDCTL_OPENROUTER_API_KEY',
    })).toEqual({
      lane: 'provider:openrouter',
      name: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'process-local-provider-key',
    });
    const hostile = {
      id: 'provider-hostile',
      runtime: 'provider-api',
      metadata: {
        runtime: 'provider:hostile',
        providerRuntime: {
          lane: 'provider:hostile',
          name: 'hostile',
          baseUrl: 'https://attacker.example/v1',
          keyEnv: 'BRAIN_TOKEN',
        },
      },
    };
    const quarantined = manager.buildLocalAgentEnv(
      'team-id',
      'default',
      43145,
      hostile,
    );
    expect(quarantined.ID_PROVIDER_API_KEY).toBeUndefined();
    expect(quarantined.ID_PROVIDER_BASE_URL).toBeUndefined();
    expect(JSON.stringify(quarantined)).not.toContain('manager-brain-secret');

    const safePersisted = manager.buildLocalAgentEnv(
      'team-id',
      'default',
      43146,
      {
        id: 'provider-safe',
        runtime: 'provider-api',
        metadata: {
          runtime: 'provider:openrouter',
          providerRuntime: {
            lane: 'provider:openrouter',
            name: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            keyEnv: 'OPENROUTER_API_KEY',
          },
        },
      },
    );
    expect(safePersisted.ID_PROVIDER_API_KEY).toBe('reviewed-provider-key');
    expect(safePersisted.ID_PROVIDER_BASE_URL).toBe('https://openrouter.ai/api/v1');

    manager.providerRuntimeAssignments.set('provider-memory', {
      lane: 'provider:trusted',
      name: 'trusted',
      baseUrl: 'https://trusted.example/v1',
      apiKey: 'process-local-provider-key',
    });
    const remembered = manager.buildLocalAgentEnv(
      'team-id',
      'default',
      43147,
      {
        id: 'provider-memory',
        runtime: 'provider-api',
        metadata: {
          runtime: 'provider:hostile',
          providerRuntime: {
            lane: 'provider:hostile',
            name: 'hostile',
            baseUrl: 'https://attacker.example/v1',
            keyEnv: 'BRAIN_TOKEN',
          },
        },
      },
    );
    expect(remembered.ID_PROVIDER_API_KEY).toBe('process-local-provider-key');
    expect(remembered.ID_PROVIDER_BASE_URL).toBe('https://trusted.example/v1');
  });

  it('forwards a trimmed custom Codex provider home and only a validated XMTP network', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-worker-provider-env-'));
    workDirs.push(workDir);
    const providerHome = path.join(workDir, 'profiles', 'default', 'provider-codex');
    for (const key of ENV_KEYS) originals.set(key, process.env[key]);
    process.env.CODEX_HOME = `  ${providerHome}  `;
    process.env.XMTP_ENV = 'production';

    const manager = new AgentManagerDb(workDir, {} as any, { libraryRoot: null }) as any;
    const codex = manager.buildLocalAgentEnv(
      'team-id',
      'default',
      43129,
      { id: 'codex-id', runtime: 'codex', metadata: {} },
    );
    expect(codex.CODEX_HOME).toBe(providerHome);
    expect(codex.XMTP_ENV).toBe('production');
    expect(codex.XMTP_DB_PATH).toBeUndefined();
    expect(codex.XMTP_WALLET_KEY).toBeUndefined();

    process.env.XMTP_ENV = 'staging';
    const invalid = manager.buildLocalAgentEnv(
      'team-id',
      'default',
      43130,
      { id: 'codex-id', runtime: 'codex', metadata: {} },
    );
    expect(invalid.XMTP_ENV).toBeUndefined();

    const claude = manager.buildLocalAgentEnv(
      'team-id',
      'default',
      43131,
      { id: 'claude-id', runtime: 'claude-code-cli', metadata: {} },
    );
    expect(claude.CODEX_HOME).toBeUndefined();
  });

  it('hands profile workers SQLite and the fallback workspace only without higher-precedence settings', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-worker-db-env-'));
    workDirs.push(workDir);
    const profileDataDir = path.join(workDir, 'profiles', 'default');
    const sqlitePath = path.join(profileDataDir, 'manager', 'id-agents.db');
    const fallbackWorkspace = path.join(profileDataDir, 'workspace');
    for (const key of ENV_KEYS) {
      originals.set(key, process.env[key]);
    }
    process.env.SQLITE_PATH = sqlitePath;
    delete process.env.DATABASE_URL;
    delete process.env.ID_WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = fallbackWorkspace;

    const manager = new AgentManagerDb(workDir, {} as any, { libraryRoot: null }) as any;
    const env = manager.buildLocalAgentEnv(
      'team-id',
      'default',
      43124,
      { runtime: 'codex', metadata: {} },
    );

    expect(env.SQLITE_PATH).toBe(sqlitePath);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.ID_WORKSPACE_DIR).toBe(fallbackWorkspace);
    expect(env.WORKSPACE_DIR).toBeUndefined();
  });

  it('pins output speed for Claude Code workers without leaking it to unsupported runtimes', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-worker-speed-env-'));
    workDirs.push(workDir);
    const manager = new AgentManagerDb(workDir, {} as any, { libraryRoot: null }) as any;

    const defaultClaude = manager.buildLocalAgentEnv(
      'team-id',
      'default',
      43125,
      { runtime: 'claude-code-cli', metadata: {} },
    );
    const fastClaude = manager.buildLocalAgentEnv(
      'team-id',
      'default',
      43126,
      { runtime: 'claude-code-local', metadata: { speed: 'fast' } },
    );
    const invalidClaude = manager.buildLocalAgentEnv(
      'team-id',
      'default',
      43127,
      { runtime: 'claude-code-cli', metadata: { speed: 'turbo' } },
    );
    const codex = manager.buildLocalAgentEnv(
      'team-id',
      'default',
      43128,
      { runtime: 'codex', metadata: { speed: 'fast' } },
    );

    expect(defaultClaude.ID_AGENT_SPEED).toBe('default');
    expect(fastClaude.ID_AGENT_SPEED).toBe('fast');
    expect(invalidClaude.ID_AGENT_SPEED).toBe('default');
    expect(codex.ID_AGENT_SPEED).toBeUndefined();
  });
});
