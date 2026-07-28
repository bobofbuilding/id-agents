// SPDX-License-Identifier: MIT

import * as path from 'node:path';
import {
  assertNoLinkEscape,
  atomicWritePrivateFile,
  ensurePrivateDirectory,
  lstatIfExists,
  readPrivateFileNoFollow,
  stableProfileOwnerKey,
} from './profile-storage.js';

export const CONVERSATION_SESSION_STORAGE_VERSION = 1;
export const MAX_PERSISTED_CONVERSATIONS = 500;
export const MAX_SESSION_IDENTIFIER_CHARS = 1024;
export const MAX_CONVERSATION_SESSION_FILE_BYTES = 2 * 1024 * 1024;

export interface ConversationSessionStorage {
  profileRoot: string;
  directory: string;
  filePath: string;
}

interface ConversationSessionEntry {
  conversationKey: string;
  sessionId: string;
}

interface ConversationSessionDocument {
  version: number;
  runtime: string;
  entries: ConversationSessionEntry[];
}

export function normalizeConversationSessionIdentifier(
  value: unknown,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_IDENTIFIER_CHARS) return undefined;
  return normalized;
}

/**
 * Resolve profile-owned session ownership. Standalone workers without a
 * selected profile deliberately remain memory-only; they never fall back to
 * HOME or an application source directory.
 */
export function resolveConversationSessionStorage(input: {
  env?: NodeJS.ProcessEnv;
  stableAgentId?: string;
  displayFallback: string;
}): ConversationSessionStorage | null {
  const env = input.env ?? process.env;
  const profileRootValue = env.IDACC_DATA_DIR?.trim();
  const managed = env.IDACC_MANAGED_SERVICE === '1';
  if (!profileRootValue) {
    if (managed) {
      throw new Error('runtime session continuity requires IDACC_DATA_DIR in managed mode');
    }
    return null;
  }

  const profileRoot = path.resolve(profileRootValue);
  assertNoLinkEscape(profileRoot, profileRoot);
  const owner = stableProfileOwnerKey(
    input.stableAgentId,
    input.displayFallback,
    managed,
  );
  const directory = path.join(
    profileRoot,
    'manager',
    'runtime-sessions',
    'agents',
    owner,
  );
  ensurePrivateDirectory(profileRoot, directory);
  return {
    profileRoot,
    directory,
    filePath: path.join(directory, 'conversation-sessions.json'),
  };
}

function parseDocument(
  serialized: Buffer,
  runtime: string,
): Map<string, string> {
  let document: ConversationSessionDocument;
  try {
    document = JSON.parse(serialized.toString('utf8')) as ConversationSessionDocument;
  } catch {
    throw new Error('profile runtime session ownership file is not valid JSON');
  }
  if (
    !document
    || document.version !== CONVERSATION_SESSION_STORAGE_VERSION
    || typeof document.runtime !== 'string'
    || !Array.isArray(document.entries)
    || document.entries.length > MAX_PERSISTED_CONVERSATIONS
  ) {
    throw new Error('profile runtime session ownership file is invalid');
  }

  // Runtime session identifiers are provider-specific. A runtime change starts
  // with an empty ownership map rather than feeding another provider's IDs into
  // the new harness.
  if (document.runtime !== runtime) return new Map();

  const sessions = new Map<string, string>();
  for (const entry of document.entries) {
    const conversationKey = normalizeConversationSessionIdentifier(entry?.conversationKey);
    const sessionId = normalizeConversationSessionIdentifier(entry?.sessionId);
    if (!conversationKey || !sessionId || sessions.has(conversationKey)) {
      throw new Error('profile runtime session ownership entry is invalid');
    }
    sessions.set(conversationKey, sessionId);
  }
  return sessions;
}

export function loadConversationSessionOwnership(
  storage: ConversationSessionStorage | null,
  runtime: string,
): Map<string, string> {
  if (!storage || !lstatIfExists(storage.filePath)) return new Map();
  return parseDocument(
    readPrivateFileNoFollow(storage.profileRoot, storage.filePath, {
      harden: true,
      maxBytes: MAX_CONVERSATION_SESSION_FILE_BYTES,
    }),
    runtime,
  );
}

export function conversationSessionOwnershipExists(
  storage: ConversationSessionStorage | null,
): boolean {
  return Boolean(storage && lstatIfExists(storage.filePath));
}

export function persistConversationSessionOwnership(
  storage: ConversationSessionStorage | null,
  runtime: string,
  sessions: ReadonlyMap<string, string>,
): void {
  if (!storage) return;
  if (sessions.size > MAX_PERSISTED_CONVERSATIONS) {
    throw new Error('profile runtime session ownership exceeds its conversation limit');
  }
  const entries: ConversationSessionEntry[] = [];
  for (const [rawConversationKey, rawSessionId] of sessions) {
    const conversationKey = normalizeConversationSessionIdentifier(rawConversationKey);
    const sessionId = normalizeConversationSessionIdentifier(rawSessionId);
    if (!conversationKey || !sessionId) {
      throw new Error('profile runtime session ownership entry is invalid');
    }
    entries.push({ conversationKey, sessionId });
  }
  const document: ConversationSessionDocument = {
    version: CONVERSATION_SESSION_STORAGE_VERSION,
    runtime,
    entries,
  };
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CONVERSATION_SESSION_FILE_BYTES) {
    throw new Error('profile runtime session ownership exceeds its file limit');
  }
  atomicWritePrivateFile(storage.profileRoot, storage.filePath, serialized);
}
