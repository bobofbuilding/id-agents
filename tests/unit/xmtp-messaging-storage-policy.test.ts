// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_ADDRESS = '0x1111111111111111111111111111111111111111';
const TEST_INBOX_ID = 'managed-raw-inbox';

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  createFromEnv: vi.fn(),
  createBackend: vi.fn(async () => ({})),
  getInboxIdForIdentifier: vi.fn(async () => 'managed-raw-inbox'),
}));

function fakeAgent(address = TEST_ADDRESS) {
  return {
    address,
    on: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

vi.mock('@xmtp/agent-sdk', () => ({
  Agent: {
    create: sdk.create,
    createFromEnv: sdk.createFromEnv,
  },
  createBackend: sdk.createBackend,
  createNameResolver: vi.fn(() => async () => null),
  createSigner: vi.fn(() => ({
    getIdentifier: async () => ({
      identifier: TEST_ADDRESS,
      identifierKind: 'Ethereum',
    }),
    signMessage: async () => new Uint8Array(),
    type: 'EOA',
  })),
  createUser: vi.fn(() => ({ account: { address: TEST_ADDRESS } })),
  generateInboxId: vi.fn(() => TEST_INBOX_ID),
  getInboxIdForIdentifier: sdk.getInboxIdForIdentifier,
}));

vi.mock('../../src/xmtp/ows-signer.js', () => ({
  createOwsSigner: vi.fn(() => ({
    address: TEST_ADDRESS,
    signer: {
      getIdentifier: async () => ({
        identifier: TEST_ADDRESS,
        identifierKind: 'Ethereum',
      }),
      signMessage: async () => new Uint8Array(),
      type: 'EOA',
    },
  })),
}));

import { AgentRestServer } from '../../src/claude-agent-server.js';
import { XmtpMessaging } from '../../src/xmtp/xmtp-messaging.js';
import { MAX_XMTP_MESSAGE_BYTES } from '../../src/xmtp/ingress-policy.js';

const temporaryRoots: string[] = [];
const ENV_KEYS = [
  'HOME',
  'IDACC_DATA_DIR',
  'IDACC_MANAGED_SERVICE',
  'ID_AGENT_ID',
  'XMTP_DB_DIRECTORY',
  'XMTP_DB_ENCRYPTION_KEY',
  'XMTP_ENV',
  'XMTP_GATEWAY_HOST',
  'XMTP_WALLET_KEY',
] as const;
let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of ENV_KEYS) delete process.env[key];
  sdk.create.mockReset();
  sdk.createFromEnv.mockReset();
  sdk.createBackend.mockClear();
  sdk.getInboxIdForIdentifier.mockClear();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `id-agents-${label}-`));
  temporaryRoots.push(root);
  return root;
}

describe('XmtpMessaging storage policy', () => {
  it('preserves the exact standalone OWS HOME database location', async () => {
    const home = temporaryRoot('xmtp-standalone-ows-runtime');
    process.env.HOME = home;
    let openedDatabase: string | undefined;
    sdk.create.mockImplementation(async (_signer, options) => {
      openedDatabase = options.dbPath(TEST_INBOX_ID);
      return fakeAgent();
    });

    const messaging = new XmtpMessaging({
      env: 'production',
      owsWallet: 'standalone-wallet',
    });
    await messaging.start();

    expect(openedDatabase).toBe(path.join(
      fs.realpathSync(home),
      '.xmtp',
      TEST_ADDRESS,
      'production.db3',
    ));
    expect(sdk.createFromEnv).not.toHaveBeenCalled();
  });

  it('preserves standalone raw createFromEnv DB and encryption semantics', async () => {
    const home = temporaryRoot('xmtp-standalone-runtime');
    process.env.HOME = home;
    process.env.XMTP_WALLET_KEY = `0x${'12'.repeat(32)}`;
    sdk.createFromEnv.mockResolvedValue(fakeAgent());

    const messaging = new XmtpMessaging({ env: 'dev' });
    await messaging.start();

    expect(sdk.createFromEnv).toHaveBeenCalledWith({ env: 'dev' });
    expect(sdk.create).not.toHaveBeenCalled();
    await messaging.allowSender('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(fs.existsSync(path.join(
      fs.realpathSync(home),
      '.xmtp',
      TEST_ADDRESS,
      'allowlist.yaml',
    ))).toBe(true);
  });

  it('uses the SDK inbox callback to migrate a managed unencrypted raw DB exactly', async () => {
    const root = temporaryRoot('xmtp-managed-raw-runtime');
    const profile = path.join(root, 'profile');
    const legacyCwd = path.join(root, 'old-process-cwd');
    const storageOwner = path.join(profile, 'manager', 'xmtp', 'agents', 'stable-owner');
    fs.mkdirSync(profile);
    fs.mkdirSync(legacyCwd);
    const source = path.join(legacyCwd, `xmtp-dev-${TEST_INBOX_ID}.db3`);
    fs.writeFileSync(source, 'retained-raw-installation');
    process.env.IDACC_MANAGED_SERVICE = '1';
    process.env.IDACC_DATA_DIR = profile;
    let openedDatabase: string | undefined;
    let createOptions: Record<string, unknown> | undefined;
    sdk.create.mockImplementation(async (_signer, options) => {
      createOptions = options;
      openedDatabase = options.dbPath(TEST_INBOX_ID);
      return fakeAgent();
    });

    const messaging = new XmtpMessaging({
      env: 'dev',
      walletKey: `0x${'34'.repeat(32)}`,
      workingDirectory: storageOwner,
      legacyProcessWorkingDirectory: legacyCwd,
    });
    await messaging.start();

    expect(sdk.getInboxIdForIdentifier).toHaveBeenCalledOnce();
    expect(openedDatabase).toContain(path.join(storageOwner, '.xmtp', TEST_ADDRESS));
    expect(fs.readFileSync(openedDatabase!, 'utf8')).toBe('retained-raw-installation');
    expect(createOptions).not.toHaveProperty('dbEncryptionKey');
    expect(fs.existsSync(source)).toBe(true);
    expect(sdk.createFromEnv).not.toHaveBeenCalled();
  });

  it('cleans a failed start, permits retry, and stops the active SDK client', async () => {
    const home = temporaryRoot('xmtp-start-retry');
    process.env.HOME = home;
    process.env.XMTP_WALLET_KEY = `0x${'56'.repeat(32)}`;
    const failedAgent = fakeAgent();
    failedAgent.start.mockRejectedValueOnce(new Error('stream setup failed'));
    const retriedAgent = fakeAgent();
    sdk.createFromEnv
      .mockResolvedValueOnce(failedAgent)
      .mockResolvedValueOnce(retriedAgent);
    const messaging = new XmtpMessaging({ env: 'dev' });

    await expect(messaging.start()).rejects.toThrow(/stream setup failed/i);
    expect(failedAgent.stop).toHaveBeenCalledOnce();
    expect(messaging.address).toBeNull();

    await Promise.all([messaging.start(), messaging.start()]);
    expect(sdk.createFromEnv).toHaveBeenCalledTimes(2);
    expect(messaging.address).toBe(TEST_ADDRESS);

    await messaging.stop();
    expect(retriedAgent.stop).toHaveBeenCalledOnce();
    expect(messaging.address).toBeNull();
  });

  it('stops again after a pending SDK start settles and does not leak a stale client', async () => {
    const home = temporaryRoot('xmtp-stale-start-stop');
    process.env.HOME = home;
    process.env.XMTP_WALLET_KEY = `0x${'78'.repeat(32)}`;
    let releaseStart!: () => void;
    const deferredAgent = fakeAgent();
    deferredAgent.start.mockImplementation(() => new Promise<void>((resolve) => {
      releaseStart = resolve;
    }));
    sdk.createFromEnv.mockResolvedValue(deferredAgent);
    const messaging = new XmtpMessaging({ env: 'dev' });

    const start = messaging.start();
    await vi.waitFor(() => expect(deferredAgent.start).toHaveBeenCalledOnce());
    const stop = messaging.stop();
    await vi.waitFor(() => expect(deferredAgent.stop).toHaveBeenCalledOnce());

    releaseStart();
    await Promise.all([start, stop]);

    expect(deferredAgent.stop).toHaveBeenCalledTimes(2);
    expect(messaging.address).toBeNull();
  });

  it('does not turn an SDK stream error into an unhandled EventEmitter exception', async () => {
    const home = temporaryRoot('xmtp-safe-stream-error');
    process.env.HOME = home;
    process.env.XMTP_WALLET_KEY = `0x${'90'.repeat(32)}`;
    const agent = fakeAgent();
    sdk.createFromEnv.mockResolvedValue(agent);
    const messaging = new XmtpMessaging({ env: 'dev' });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await messaging.start();
      const handler = agent.on.mock.calls.find(([event]) => event === 'unhandledError')?.[1];
      expect(handler).toBeTypeOf('function');
      expect(() => handler(new Error('recoverable stream error'))).not.toThrow();
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      await messaging.stop();
    }
  });

  it('prevents Manager shutdown from publishing an XMTP client after dynamic startup', async () => {
    const root = temporaryRoot('xmtp-manager-late-start');
    const profile = path.join(root, 'profile');
    fs.mkdirSync(profile);
    process.env.IDACC_MANAGED_SERVICE = '1';
    process.env.IDACC_DATA_DIR = profile;
    process.env.ID_AGENT_ID = 'agent-manager-lifecycle';
    process.env.XMTP_WALLET_KEY = `0x${'ab'.repeat(32)}`;
    const server = new AgentRestServer({
      agentName: 'lead',
      harness: {
        type: 'codex',
        async *run() {
          yield { type: 'result', result: 'unused' };
        },
      } as any,
    });

    const pendingStart = (server as any).beginXmtpStart(4101);
    const stop = server.stop();
    await Promise.all([pendingStart, stop]);

    expect(sdk.create).not.toHaveBeenCalled();
    expect((server as any).xmtp).toBeNull();
    expect((server as any).xmtpStartPromise).toBeNull();
  });

  it('drops oversized XMTP content before constructing or queuing a prompt', async () => {
    const root = temporaryRoot('xmtp-manager-oversized');
    const profile = path.join(root, 'profile');
    fs.mkdirSync(profile);
    process.env.IDACC_MANAGED_SERVICE = '1';
    process.env.IDACC_DATA_DIR = profile;
    process.env.ID_AGENT_ID = 'agent-manager-ingress';
    process.env.XMTP_WALLET_KEY = `0x${'cd'.repeat(32)}`;
    sdk.create.mockResolvedValue(fakeAgent());
    const server = new AgentRestServer({
      agentName: 'lead',
      harness: {
        type: 'claude-agent-sdk',
        async *run() {
          yield { type: 'result', result: 'must not run' };
        },
      } as any,
    });
    const startQuery = vi.spyOn(server as any, 'startQuery');

    try {
      await (server as any).startXmtp(4101, 0);
      const handler = (server as any).xmtp.messageHandler;
      await expect(handler({
        senderAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        isDm: true,
        conversationId: 'oversized',
        content: 'a'.repeat(MAX_XMTP_MESSAGE_BYTES + 1),
        timestamp: Date.now(),
      })).resolves.toBeUndefined();

      expect(startQuery).not.toHaveBeenCalled();
      expect((server as any).pendingXmtpQueryIds.size).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it('wires Manager shutdown to the XMTP stop lifecycle', () => {
    const source = fs.readFileSync(
      new URL('../../src/claude-agent-server.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('const xmtp = this.xmtp;');
    expect(source).toContain('await xmtp.stop();');
  });
});
