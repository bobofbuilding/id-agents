// SPDX-License-Identifier: MIT

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  assertNoLinkEscape,
  atomicWritePrivateFile,
  lstatIfExists,
  readPrivateFileNoFollow,
} from './profile-storage.js';
import {
  portableOverlayPathSegmentError,
  portablePathSegmentKey,
  portableRelativePathKey,
} from './portable-path-segment.js';

const RECEIPT_SCHEMA_VERSION = 2;
const DEFAULT_RECEIPT = '.id-agents/managed-overlay-receipt.json';
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const LEGACY_RECOVERY_ROOT = '.id-agents/managed-overlay-recovery';
const SHA256 = /^[0-9a-f]{64}$/;

export interface ManagedOverlayTree {
  /** A real source directory. Symlinks inside the tree are rejected. */
  source: string;
  /** Portable path relative to workspaceRoot. Empty means the workspace root. */
  destination: string;
}

export interface ManagedOverlayFile {
  /** Portable file path relative to workspaceRoot. */
  destination: string;
  /** Exactly one of source or content is required. */
  source?: string;
  content?: string | Buffer;
  /** Only the executable bit is retained; files otherwise use owner-only mode. */
  mode?: number;
  /**
   * Defaults to true. Set false only when reading an existing managed target
   * as a compatibility source: unchanged receipt-owned bytes remain cleanable,
   * but drifted or already-unowned bytes are never adopted into ownership.
   */
  claimExisting?: boolean;
}

export interface ManagedOverlayMarkerBlock {
  /** Stable id rendered in `<!-- BEGIN/END id-agents <id> -->` fences. */
  id: string;
  /** Managed body between the marker fences. */
  content: string | Buffer;
}

export interface ManagedOverlayMarkerFile {
  /** Portable host-file path relative to workspaceRoot. */
  destination: string;
  /**
   * Desired managed blocks in this shared host file. An empty array removes
   * retired id-agents blocks while preserving every byte outside them.
   */
  blocks: ManagedOverlayMarkerBlock[];
}

export interface ManagedOverlayReconcileOptions {
  workspaceRoot: string;
  receiptPath?: string;
  trees?: ManagedOverlayTree[];
  files?: ManagedOverlayFile[];
  markerFiles?: ManagedOverlayMarkerFile[];
  /** Validate every source, target, receipt, and ownership boundary without writing. */
  preflightOnly?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  /**
   * One-time migration for workspaces created before aggregate receipts.
   * Conflicting exact files are archived byte-for-byte before replacement and
   * the historical nested framework marker is retired while outside text is
   * preserved. This is ignored once a receipt exists.
   */
  recoverPreReceiptWorkspace?: boolean;
}

export interface ManagedOverlayReconcileResult {
  archived: Array<{ path: string; recoveryPath: string }>;
  written: string[];
  removed: string[];
  unchanged: string[];
  preserved: string[];
  receiptPath: string;
}

interface DesiredFile {
  claimExisting: boolean;
  contents: Buffer;
  mode: number;
  path: string;
  sha256: string;
}

interface DesiredMarkerBlock {
  block: string;
  id: string;
  sha256: string;
}

interface ReceiptFile {
  mode: number;
  previousSha256?: string;
  sha256: string;
  state: 'owned' | 'pending';
}

interface ReceiptMarkerBlock {
  previousSha256?: string;
  sha256: string;
  state: 'owned' | 'pending';
}

interface ManagedOverlayReceipt {
  schemaVersion: 2;
  files: Record<string, ReceiptFile>;
  markers: Record<string, Record<string, ReceiptMarkerBlock>>;
  createdDirectories: string[];
}

function fail(message: string): never {
  throw new Error(`managed overlay: ${message}`);
}

function sha256(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

function ownerMode(mode: number | undefined): number {
  return typeof mode === 'number' && (mode & 0o111) !== 0 ? 0o700 : 0o600;
}

/**
 * Validate one path segment against the common macOS/Linux/Windows packaging
 * boundary. This intentionally permits dot-prefixed runtime roots such as
 * `.claude`, while rejecting names Windows aliases to devices.
 */
export function validatePortableOverlaySegment(segment: string): void {
  const error = portableOverlayPathSegmentError(segment);
  if (error) {
    fail(`unsafe portable path segment "${segment || '(empty)'}": ${error}`);
  }
}

function portableRelativePath(value: string, options: { allowEmpty?: boolean } = {}): string {
  const raw = String(value ?? '').replaceAll('\\', '/');
  if (raw === '' && options.allowEmpty) return '';
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || isAbsolute(raw)) {
    fail(`path must be portable and relative: ${value || '(empty)'}`);
  }
  const segments = raw.split('/');
  for (const segment of segments) validatePortableOverlaySegment(segment);
  return segments.join('/');
}

const MARKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const MANAGED_MARKER_PATTERN = /<!-- (BEGIN|END) id-agents ([^>\r\n]+) -->/g;

interface ParsedMarkerBlock {
  block: string;
  end: number;
  id: string;
  sha256: string;
  start: number;
}

function validateMarkerId(id: string): void {
  if (!MARKER_ID_PATTERN.test(id)) {
    fail(`unsafe managed marker id "${id || '(empty)'}"`);
  }
}

function canonicalMarkerBlock(id: string, content: string | Buffer): string {
  validateMarkerId(id);
  const body = (Buffer.isBuffer(content) ? content.toString('utf8') : content)
    .replace(/\n+$/, '');
  if (/<!-- (?:BEGIN|END) id-agents [^>\r\n]+ -->/.test(body)) {
    fail(`managed marker body must not contain id-agents marker fences: ${id}`);
  }
  return `<!-- BEGIN id-agents ${id} -->\n${body}\n<!-- END id-agents ${id} -->\n`;
}

/**
 * Parse every id-agents marker in a shared host file. The parser rejects
 * duplicates, nesting, mismatched ends, and dangling markers before callers
 * perform any mutation.
 */
function parseManagedMarkerBlocks(contents: string, pathLabel: string): Map<string, ParsedMarkerBlock> {
  const parsed = new Map<string, ParsedMarkerBlock>();
  let open: { id: string; start: number } | null = null;
  MANAGED_MARKER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MANAGED_MARKER_PATTERN.exec(contents)) !== null) {
    const kind = match[1];
    const id = match[2].trim();
    validateMarkerId(id);
    if (kind === 'BEGIN') {
      if (open) fail(`nested managed markers in ${pathLabel}: ${open.id}, ${id}`);
      if (parsed.has(id)) fail(`duplicate managed marker "${id}" in ${pathLabel}`);
      open = { id, start: match.index };
      continue;
    }
    if (!open || open.id !== id) {
      fail(`mismatched managed marker "${id}" in ${pathLabel}`);
    }
    let end = match.index + match[0].length;
    if (contents.startsWith('\r\n', end)) end += 2;
    else if (contents.startsWith('\n', end)) end += 1;
    const block = contents.slice(open.start, end);
    parsed.set(id, {
      block,
      end,
      id,
      sha256: sha256(Buffer.from(block, 'utf8')),
      start: open.start,
    });
    open = null;
  }
  if (open) fail(`unterminated managed marker "${open.id}" in ${pathLabel}`);
  return parsed;
}

function upsertManagedMarkerBlock(
  contents: string,
  desired: DesiredMarkerBlock,
  pathLabel: string,
): string {
  const parsed = parseManagedMarkerBlocks(contents, pathLabel);
  const current = parsed.get(desired.id);
  if (current) {
    return `${contents.slice(0, current.start)}${desired.block}${contents.slice(current.end)}`;
  }
  if (contents.length === 0) return desired.block;
  const separator = contents.endsWith('\n\n')
    ? ''
    : contents.endsWith('\n')
      ? '\n'
      : '\n\n';
  return `${contents}${separator}${desired.block}`;
}

function removeManagedMarkerBlock(
  contents: string,
  id: string,
  pathLabel: string,
): string {
  const parsed = parseManagedMarkerBlocks(contents, pathLabel);
  const current = parsed.get(id);
  if (!current) return contents;
  return `${contents.slice(0, current.start)}${contents.slice(current.end)}`;
}

function absoluteTarget(root: string, portablePath: string): string {
  const target = resolve(root, ...portablePath.split('/'));
  const rel = relative(root, target);
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    fail(`target escapes or aliases the workspace root: ${portablePath}`);
  }
  return target;
}

function relativePortable(root: string, target: string): string {
  return relative(root, target).split(sep).join('/');
}

function assertCaseAndLinkSafePath(
  root: string,
  portablePath: string,
  kind: 'file' | 'directory',
): string {
  const target = absoluteTarget(root, portablePath);
  const segments = portablePath.split('/');
  let cursor = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const parentStat = lstatSync(cursor);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      fail(`destination ancestor is not a real directory: ${cursor}`);
    }
    const folded = portablePathSegmentKey(segment);
    const collision = readdirSync(cursor).find(
      (entry) => portablePathSegmentKey(entry) === folded && entry !== segment,
    );
    if (collision) {
      fail(`case-fold or normalization path collision between "${collision}" and "${segment}"`);
    }
    cursor = join(cursor, segment);
    const stat = lstatIfExists(cursor);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      fail(`destination path contains a symlink or junction: ${cursor}`);
    }
    const final = index === segments.length - 1;
    if (!final && !stat.isDirectory()) {
      fail(`destination ancestor is not a directory: ${cursor}`);
    }
    if (final && kind === 'file' && !stat.isFile()) {
      fail(`destination file is not a regular file: ${cursor}`);
    }
    if (final && kind === 'directory' && !stat.isDirectory()) {
      fail(`destination directory is not a directory: ${cursor}`);
    }
  }
  assertNoLinkEscape(root, target);
  return target;
}

function readReceipt(root: string, receiptPath: string): ManagedOverlayReceipt {
  const absolute = assertCaseAndLinkSafePath(root, receiptPath, 'file');
  if (!existsSync(absolute)) {
    return {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      files: {},
      markers: {},
      createdDirectories: [],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readPrivateFileNoFollow(root, absolute, { maxBytes: 4 * 1024 * 1024 })
        .toString('utf8'),
    );
  } catch (error) {
    fail(`receipt is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('receipt must be an object');
  }
  const value = parsed as Partial<ManagedOverlayReceipt>;
  const schemaVersion = Number(value.schemaVersion);
  if (
    (schemaVersion !== 1 && schemaVersion !== RECEIPT_SCHEMA_VERSION)
    || !value.files
    || typeof value.files !== 'object'
    || Array.isArray(value.files)
    || !Array.isArray(value.createdDirectories)
  ) {
    fail('receipt has an unsupported shape');
  }
  const files: Record<string, ReceiptFile> = {};
  const pathIdentities = new Map<string, string>();
  for (const [rawPath, rawEntry] of Object.entries(value.files)) {
    const path = portableRelativePath(rawPath);
    const identity = portableRelativePathKey(path);
    const collision = pathIdentities.get(identity);
    if (collision) {
      fail(`receipt contains a case-fold or normalization duplicate: ${collision}, ${path}`);
    }
    pathIdentities.set(identity, path);
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      fail(`receipt entry is invalid: ${path}`);
    }
    const entry = rawEntry as Partial<ReceiptFile>;
    if (
      !SHA256.test(String(entry.sha256 || ''))
      || (entry.state !== 'owned' && entry.state !== 'pending')
      || (entry.previousSha256 !== undefined && !SHA256.test(entry.previousSha256))
      || (entry.mode !== 0o600 && entry.mode !== 0o700)
    ) {
      fail(`receipt entry has invalid ownership metadata: ${path}`);
    }
    files[path] = {
      sha256: entry.sha256!,
      state: entry.state,
      mode: entry.mode,
      ...(entry.previousSha256 && { previousSha256: entry.previousSha256 }),
    };
  }
  const markers: Record<string, Record<string, ReceiptMarkerBlock>> = {};
  const rawMarkers = schemaVersion === 1
    ? {}
    : (value.markers as unknown);
  if (!rawMarkers || typeof rawMarkers !== 'object' || Array.isArray(rawMarkers)) {
    fail('receipt marker ownership has an invalid shape');
  }
  for (const [rawPath, rawEntries] of Object.entries(
    rawMarkers as Record<string, unknown>,
  )) {
    const path = portableRelativePath(rawPath);
    const identity = portableRelativePathKey(path);
    if (pathIdentities.has(identity)) {
      fail(`receipt mixes whole-file and marker ownership for: ${path}`);
    }
    pathIdentities.set(identity, path);
    if (!rawEntries || typeof rawEntries !== 'object' || Array.isArray(rawEntries)) {
      fail(`receipt marker entries are invalid: ${path}`);
    }
    const entries: Record<string, ReceiptMarkerBlock> = {};
    for (const [id, rawEntry] of Object.entries(rawEntries as Record<string, unknown>)) {
      validateMarkerId(id);
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        fail(`receipt marker entry is invalid: ${path}#${id}`);
      }
      const entry = rawEntry as Partial<ReceiptMarkerBlock>;
      if (
        !SHA256.test(String(entry.sha256 || ''))
        || (entry.state !== 'owned' && entry.state !== 'pending')
        || (entry.previousSha256 !== undefined && !SHA256.test(entry.previousSha256))
      ) {
        fail(`receipt marker entry has invalid ownership metadata: ${path}#${id}`);
      }
      entries[id] = {
        sha256: entry.sha256!,
        state: entry.state,
        ...(entry.previousSha256 && { previousSha256: entry.previousSha256 }),
      };
    }
    markers[path] = entries;
  }
  const createdDirectories: string[] = [];
  const createdDirectoryIdentities = new Map<string, string>();
  for (const item of value.createdDirectories) {
    const path = portableRelativePath(String(item));
    const identity = portableRelativePathKey(path);
    const collision = createdDirectoryIdentities.get(identity);
    if (collision && collision !== path) {
      fail(`receipt contains a case-fold or normalization directory duplicate: ${collision}, ${path}`);
    }
    if (!collision) {
      createdDirectoryIdentities.set(identity, path);
      createdDirectories.push(path);
    }
  }
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    files,
    markers,
    createdDirectories,
  };
}

function writeReceipt(root: string, receiptPath: string, receipt: ManagedOverlayReceipt): void {
  const orderedFiles = Object.fromEntries(
    Object.entries(receipt.files).sort(([left], [right]) => left.localeCompare(right)),
  );
  const orderedMarkers = Object.fromEntries(
    Object.entries(receipt.markers)
      .filter(([, entries]) => Object.keys(entries).length > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, entries]) => [
        path,
        Object.fromEntries(
          Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)),
        ),
      ]),
  );
  atomicWritePrivateFile(
    root,
    absoluteTarget(root, receiptPath),
    `${JSON.stringify({
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      files: orderedFiles,
      markers: orderedMarkers,
      createdDirectories: [...new Set(receipt.createdDirectories)].sort(),
    }, null, 2)}\n`,
  );
}

function enumerateTree(sourceRoot: string): Array<{
  contents: Buffer;
  mode: number;
  relativePath: string;
}> {
  const rootStat = lstatSync(sourceRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail(`tree source must be a real directory: ${sourceRoot}`);
  }
  const result: Array<{ contents: Buffer; mode: number; relativePath: string }> = [];
  const visit = (directory: string, prefix: string): void => {
    const names = readdirSync(directory).sort((left, right) => left.localeCompare(right));
    const folded = new Map<string, string>();
    for (const name of names) {
      validatePortableOverlaySegment(name);
      const key = portablePathSegmentKey(name);
      const collision = folded.get(key);
      if (collision) {
        fail(`source tree contains a case-fold or normalization duplicate: ${collision}, ${join(directory, name)}`);
      }
      folded.set(key, join(directory, name));
      const sourcePath = join(directory, name);
      const stat = lstatSync(sourcePath);
      if (stat.isSymbolicLink()) fail(`source tree contains a symlink: ${sourcePath}`);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (stat.isDirectory()) visit(sourcePath, relativePath);
      else if (stat.isFile()) {
        result.push({
          contents: readFileSync(sourcePath),
          mode: ownerMode(stat.mode),
          relativePath,
        });
      } else {
        fail(`source tree contains an unsupported entry: ${sourcePath}`);
      }
    }
  };
  visit(sourceRoot, '');
  return result;
}

function desiredFiles(options: ManagedOverlayReconcileOptions): Map<string, DesiredFile> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  if (
    !Number.isSafeInteger(maxFiles)
    || maxFiles < 1
    || !Number.isSafeInteger(maxFileBytes)
    || maxFileBytes < 1
    || !Number.isSafeInteger(maxTotalBytes)
    || maxTotalBytes < maxFileBytes
  ) {
    fail('invalid overlay size limits');
  }

  const desired = new Map<string, DesiredFile>();
  const folded = new Map<string, string>();
  let totalBytes = 0;
  const add = (
    pathValue: string,
    contents: Buffer,
    mode: number,
    claimExisting: boolean = true,
  ): void => {
    const path = portableRelativePath(pathValue);
    const key = portableRelativePathKey(path);
    const collision = folded.get(key);
    if (collision) fail(`duplicate or case-fold/normalization-colliding desired targets: ${collision}, ${path}`);
    if (contents.byteLength > maxFileBytes) fail(`desired file exceeds its size limit: ${path}`);
    totalBytes += contents.byteLength;
    if (totalBytes > maxTotalBytes) fail('desired overlay exceeds its total size limit');
    if (desired.size >= maxFiles) fail('desired overlay exceeds its file-count limit');
    folded.set(key, path);
    desired.set(path, {
      claimExisting,
      contents,
      mode: ownerMode(mode),
      path,
      sha256: sha256(contents),
    });
  };

  for (const tree of options.trees || []) {
    const destination = portableRelativePath(tree.destination, { allowEmpty: true });
    const source = resolve(tree.source);
    for (const entry of enumerateTree(source)) {
      add(
        destination ? `${destination}/${entry.relativePath}` : entry.relativePath,
        entry.contents,
        entry.mode,
        true,
      );
    }
  }
  for (const file of options.files || []) {
    const hasSource = typeof file.source === 'string';
    const hasContent = file.content !== undefined;
    if (hasSource === hasContent) {
      fail(`desired file must provide exactly one source or content: ${file.destination}`);
    }
    if (hasSource) {
      const source = resolve(file.source!);
      const stat = lstatSync(source);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        fail(`file source must be a real regular file: ${source}`);
      }
      add(
        file.destination,
        readFileSync(source),
        file.mode ?? stat.mode,
        file.claimExisting !== false,
      );
    } else {
      add(
        file.destination,
        Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content!, 'utf8'),
        file.mode ?? 0o600,
        file.claimExisting !== false,
      );
    }
  }
  return desired;
}

function desiredMarkerFiles(
  options: ManagedOverlayReconcileOptions,
): Map<string, Map<string, DesiredMarkerBlock>> {
  const desired = new Map<string, Map<string, DesiredMarkerBlock>>();
  const foldedPaths = new Map<string, string>();
  for (const markerFile of options.markerFiles || []) {
    const path = portableRelativePath(markerFile.destination);
    const folded = portableRelativePathKey(path);
    const collision = foldedPaths.get(folded);
    if (collision) {
      fail(`duplicate or case-fold/normalization-colliding marker hosts: ${collision}, ${path}`);
    }
    foldedPaths.set(folded, path);
    if (!Array.isArray(markerFile.blocks)) {
      fail(`managed marker blocks must be an array: ${path}`);
    }
    const blocks = new Map<string, DesiredMarkerBlock>();
    for (const entry of markerFile.blocks) {
      validateMarkerId(entry.id);
      if (blocks.has(entry.id)) {
        fail(`duplicate managed marker "${entry.id}" for ${path}`);
      }
      const block = canonicalMarkerBlock(entry.id, entry.content);
      blocks.set(entry.id, {
        block,
        id: entry.id,
        sha256: sha256(Buffer.from(block, 'utf8')),
      });
    }
    desired.set(path, blocks);
  }
  return desired;
}

function parentDirectories(pathValue: string): string[] {
  const segments = pathValue.split('/');
  const result: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    result.push(segments.slice(0, index).join('/'));
  }
  return result;
}

function currentDigest(root: string, path: string): string | null {
  const stat = lstatIfExists(path);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(`owned target is no longer a regular file: ${path}`);
  }
  return sha256(readPrivateFileNoFollow(root, path));
}

function legacyRecoveryPath(path: string, digest: string): string {
  return `${LEGACY_RECOVERY_ROOT}/${digest}/${path}`;
}

function preflightLegacyArchive(
  root: string,
  target: string,
  path: string,
  digest: string,
  maxBytes: number,
): string {
  const contents = readPrivateFileNoFollow(root, target, { maxBytes });
  if (sha256(contents) !== digest) fail(`legacy recovery source changed while planning: ${path}`);
  const recoveryPath = legacyRecoveryPath(path, digest);
  const recoveryTarget = assertCaseAndLinkSafePath(root, recoveryPath, 'file');
  const recoveryDigest = currentDigest(root, recoveryTarget);
  if (recoveryDigest !== null && recoveryDigest !== digest) {
    fail(`legacy recovery destination is occupied by different content: ${recoveryPath}`);
  }
  return recoveryPath;
}

function archiveLegacyFile(
  root: string,
  target: string,
  path: string,
  digest: string,
  recoveryPath: string,
  maxBytes: number,
): void {
  const contents = readPrivateFileNoFollow(root, target, { maxBytes });
  if (sha256(contents) !== digest) fail(`legacy recovery source changed after preflight: ${path}`);
  const recoveryTarget = absoluteTarget(root, recoveryPath);
  if (!existsSync(recoveryTarget)) {
    atomicWritePrivateFile(root, recoveryTarget, contents, { noOverwrite: true });
  }
  if (currentDigest(root, recoveryTarget) !== digest) {
    fail(`legacy recovery archive failed its digest check: ${recoveryPath}`);
  }
}

/**
 * Older IDACC builds nested an `org` block inside the app-owned `framework`
 * block. Current marker files deliberately reject nesting. At the explicit
 * pre-receipt migration boundary, retire that one historical outer block and
 * leave every byte before and after it untouched.
 */
function removeLegacyNestedFramework(contents: string, pathLabel: string): string | null {
  const pattern = /<!-- (BEGIN|END) id-agents ([^>\r\n]+) -->/g;
  const stack: Array<{ id: string; start: number }> = [];
  let migrated: { start: number; end: number } | null = null;
  let frameworkNested = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(contents)) !== null) {
    const kind = match[1];
    const id = match[2].trim();
    validateMarkerId(id);
    if (kind === 'BEGIN') {
      if (stack.length > 0) {
        if (stack[0].id !== 'framework') {
          fail(`nested managed markers in ${pathLabel}: ${stack[0].id}, ${id}`);
        }
        frameworkNested = true;
      }
      stack.push({ id, start: match.index });
      continue;
    }
    const open = stack.at(-1);
    if (!open || open.id !== id) fail(`mismatched managed marker "${id}" in ${pathLabel}`);
    stack.pop();
    if (stack.length === 0 && id === 'framework' && frameworkNested) {
      if (migrated) fail(`duplicate managed marker "framework" in ${pathLabel}`);
      let end = match.index + match[0].length;
      if (contents.startsWith('\r\n', end)) end += 2;
      else if (contents.startsWith('\n', end)) end += 1;
      migrated = { start: open.start, end };
      frameworkNested = false;
    }
  }
  if (stack.length > 0) fail(`unterminated managed marker "${stack.at(-1)?.id}" in ${pathLabel}`);
  if (!migrated) return null;
  return `${contents.slice(0, migrated.start)}${contents.slice(migrated.end)}`;
}

/**
 * Reconcile one aggregate desired runtime overlay. Callers must resolve source
 * precedence before invoking this function. A single receipt lets plugin,
 * skill, persona, heartbeat, and library overlay transitions remain atomic
 * with respect to ownership instead of deleting one another by name.
 */
export function reconcileManagedOverlay(
  options: ManagedOverlayReconcileOptions,
): ManagedOverlayReconcileResult {
  const configuredRoot = resolve(options.workspaceRoot);
  const receiptPath = portableRelativePath(options.receiptPath || DEFAULT_RECEIPT);
  const desired = desiredFiles(options);
  const desiredMarkers = desiredMarkerFiles(options);
  const desiredExactByFold = new Map(
    [...desired.keys()].map((path) => [portableRelativePathKey(path), path]),
  );
  for (const markerPath of desiredMarkers.keys()) {
    const exactCollision = desiredExactByFold.get(portableRelativePathKey(markerPath));
    if (exactCollision) {
      fail(`target cannot mix whole-file and marker ownership: ${exactCollision}, ${markerPath}`);
    }
  }
  const receiptIdentity = portableRelativePathKey(receiptPath);
  if (
    desiredExactByFold.has(receiptIdentity)
    || [...desiredMarkers.keys()].some(
      (path) => portableRelativePathKey(path) === receiptIdentity,
    )
  ) {
    fail('desired overlay collides with its ownership receipt');
  }
  const receiptDirectory = dirname(receiptPath).replaceAll('\\', '/');
  const receiptPrefix = receiptDirectory === '.'
    ? ''
    : `${portableRelativePathKey(receiptDirectory)}/`;
  for (const path of [...desired.keys(), ...desiredMarkers.keys()]) {
    if (
      receiptPrefix
      && portableRelativePathKey(path).startsWith(receiptPrefix)
    ) {
      fail(`desired overlay enters its private receipt directory: ${path}`);
    }
  }

  if (!existsSync(configuredRoot)) {
    if (!options.preflightOnly) {
      fail(`workspace root does not exist: ${configuredRoot}`);
    }
    return {
      archived: [],
      written: [],
      removed: [],
      unchanged: [],
      preserved: [],
      receiptPath: absoluteTarget(configuredRoot, receiptPath),
    };
  }
  const rootStat = lstatSync(configuredRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail(`workspace root must be a real directory: ${configuredRoot}`);
  }
  const root = realpathSync(configuredRoot);
  const receiptTarget = assertCaseAndLinkSafePath(root, receiptPath, 'file');
  const recoverPreReceiptWorkspace = options.recoverPreReceiptWorkspace === true
    && !existsSync(receiptTarget);
  const receipt = readReceipt(root, receiptPath);
  const result: ManagedOverlayReconcileResult = {
    archived: [],
    written: [],
    removed: [],
    unchanged: [],
    preserved: [],
    receiptPath: absoluteTarget(root, receiptPath),
  };
  const existingDirectories = new Set<string>();
  const missingDirectories = new Set<string>();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const legacyFileRecoveries = new Map<string, {
    digest: string;
    recoveryPath: string;
  }>();
  const legacyMarkerMigrations = new Map<string, {
    digest: string;
    migrated: string;
    recoveryPath: string;
  }>();

  // Complete every path, collision, link, ownership, and drift preflight before
  // the first overlay file is mutated.
  for (const path of new Set([...Object.keys(receipt.files), ...desired.keys()])) {
    const target = assertCaseAndLinkSafePath(root, path, 'file');
    for (const directory of parentDirectories(path)) {
      const absolute = assertCaseAndLinkSafePath(root, directory, 'directory');
      if (existsSync(absolute)) existingDirectories.add(directory);
      else missingDirectories.add(directory);
    }
    const wanted = desired.get(path);
    const owned = receipt.files[path];
    const digest = currentDigest(root, target);
    if (!wanted) continue;
    if (!wanted.claimExisting) {
      // The file itself was the compatibility source. Its plan digest must
      // still match, but it must not pass through normal desired-file adoption
      // where a user edit can become the new receipt-owned digest.
      if (digest !== wanted.sha256) {
        fail(`retained existing file changed while planning: ${path}`);
      }
      continue;
    }
    if (
      !owned
      && digest !== null
      && digest !== wanted.sha256
    ) {
      if (!recoverPreReceiptWorkspace) {
        fail(`refusing to overwrite an unowned file: ${path}`);
      }
      legacyFileRecoveries.set(path, {
        digest,
        recoveryPath: preflightLegacyArchive(
          root,
          target,
          path,
          digest,
          maxFileBytes,
        ),
      });
    }
    if (owned && digest !== null) {
      const permitted = new Set([
        owned.sha256,
        ...(owned.previousSha256 ? [owned.previousSha256] : []),
      ]);
      if (!permitted.has(digest) && digest !== wanted.sha256) {
        fail(`refusing to overwrite a user-modified managed file: ${path}`);
      }
    }
  }

  const markerPaths = new Set([
    ...Object.keys(receipt.markers),
    ...desiredMarkers.keys(),
  ]);
  for (const path of markerPaths) {
    if (receipt.files[path] || desired.has(path)) {
      fail(`target cannot mix whole-file and marker ownership: ${path}`);
    }
    const target = assertCaseAndLinkSafePath(root, path, 'file');
    for (const directory of parentDirectories(path)) {
      const absolute = assertCaseAndLinkSafePath(root, directory, 'directory');
      if (existsSync(absolute)) existingDirectories.add(directory);
      else missingDirectories.add(directory);
    }
    const originalContents = existsSync(target)
      ? readPrivateFileNoFollow(root, target).toString('utf8')
      : '';
    let contents = originalContents;
    if (recoverPreReceiptWorkspace && existsSync(target)) {
      const migrated = removeLegacyNestedFramework(originalContents, path);
      if (migrated !== null) {
        const digest = sha256(Buffer.from(originalContents, 'utf8'));
        legacyMarkerMigrations.set(path, {
          digest,
          migrated,
          recoveryPath: preflightLegacyArchive(
            root,
            target,
            path,
            digest,
            maxFileBytes,
          ),
        });
        contents = migrated;
      }
    }
    const parsed = parseManagedMarkerBlocks(contents, path);
    const owned = receipt.markers[path] || {};

    // Marker fences were the ownership contract before aggregate receipts.
    // When a caller explicitly reconciles this host, adopt those legacy
    // id-agents blocks so source A -> B transitions remove A safely.
    if (desiredMarkers.has(path)) {
      for (const [id, block] of parsed) {
        if (!owned[id]) {
          owned[id] = {
            sha256: block.sha256,
            state: 'owned',
          };
        }
      }
    }
    receipt.markers[path] = owned;

    for (const [id, prior] of Object.entries(owned)) {
      const current = parsed.get(id);
      if (!current) continue;
      const wanted = desiredMarkers.get(path)?.get(id);
      const permitted = new Set([
        prior.sha256,
        ...(prior.previousSha256 ? [prior.previousSha256] : []),
      ]);
      if (
        wanted
        && !permitted.has(current.sha256)
        && current.sha256 !== wanted.sha256
      ) {
        fail(`refusing to overwrite a user-modified managed marker: ${path}#${id}`);
      }
    }
  }

  if (options.preflightOnly) return result;

  // Retire the historical nested marker form before normal strict marker
  // reconciliation. The complete original host file remains recoverable and
  // bytes outside the old outer framework block are retained exactly.
  for (const [path, migration] of legacyMarkerMigrations) {
    const target = absoluteTarget(root, path);
    archiveLegacyFile(
      root,
      target,
      path,
      migration.digest,
      migration.recoveryPath,
      maxFileBytes,
    );
    atomicWritePrivateFile(root, target, migration.migrated);
    result.archived.push({ path, recoveryPath: migration.recoveryPath });
  }

  // Remove retired files only while their exact retained content still proves
  // Manager ownership. Drift is released and preserved.
  for (const [path, owned] of Object.entries(receipt.files)) {
    if (desired.has(path)) continue;
    const target = absoluteTarget(root, path);
    const digest = currentDigest(root, target);
    if (digest === null) {
      delete receipt.files[path];
      continue;
    }
    const permitted = new Set([
      owned.sha256,
      ...(owned.previousSha256 ? [owned.previousSha256] : []),
    ]);
    if (!permitted.has(digest)) {
      result.preserved.push(path);
      delete receipt.files[path];
      continue;
    }
    // Recheck immediately before unlink so concurrent workspace edits are not
    // mistaken for the content inspected during preflight.
    if (currentDigest(root, target) !== digest) {
      result.preserved.push(path);
      delete receipt.files[path];
      continue;
    }
    unlinkSync(target);
    result.removed.push(path);
    delete receipt.files[path];
    writeReceipt(root, receiptPath, receipt);
  }

  // Reconcile shared host files one marker at a time. Bytes outside the
  // id-agents fences are never used as an ownership signal and are preserved
  // exactly across insert, update, and removal.
  for (const path of markerPaths) {
    const target = absoluteTarget(root, path);
    const desiredBlocks = desiredMarkers.get(path) || new Map<string, DesiredMarkerBlock>();
    const ownedBlocks = receipt.markers[path] || {};

    for (const [id, owned] of Object.entries(ownedBlocks)) {
      if (desiredBlocks.has(id)) continue;
      const contents = existsSync(target)
        ? readPrivateFileNoFollow(root, target).toString('utf8')
        : '';
      const parsed = parseManagedMarkerBlocks(contents, path);
      const current = parsed.get(id);
      if (!current) {
        delete ownedBlocks[id];
        continue;
      }
      const permitted = new Set([
        owned.sha256,
        ...(owned.previousSha256 ? [owned.previousSha256] : []),
      ]);
      if (!permitted.has(current.sha256)) {
        result.preserved.push(`${path}#${id}`);
        delete ownedBlocks[id];
        continue;
      }

      const checkedContents = readPrivateFileNoFollow(root, target).toString('utf8');
      const checked = parseManagedMarkerBlocks(checkedContents, path).get(id);
      if (!checked || checked.sha256 !== current.sha256) {
        result.preserved.push(`${path}#${id}`);
        delete ownedBlocks[id];
        continue;
      }
      const next = removeManagedMarkerBlock(checkedContents, id, path);
      atomicWritePrivateFile(root, target, next);
      result.removed.push(`${path}#${id}`);
      delete ownedBlocks[id];
      receipt.markers[path] = ownedBlocks;
      writeReceipt(root, receiptPath, receipt);
    }

    for (const [id, wanted] of desiredBlocks) {
      const contents = existsSync(target)
        ? readPrivateFileNoFollow(root, target).toString('utf8')
        : '';
      const parsed = parseManagedMarkerBlocks(contents, path);
      const current = parsed.get(id);
      const prior = ownedBlocks[id];
      if (current?.sha256 === wanted.sha256) {
        ownedBlocks[id] = {
          sha256: wanted.sha256,
          state: 'owned',
        };
        result.unchanged.push(`${path}#${id}`);
        continue;
      }
      if (prior && current) {
        const permitted = new Set([
          prior.sha256,
          ...(prior.previousSha256 ? [prior.previousSha256] : []),
        ]);
        if (!permitted.has(current.sha256)) {
          fail(`managed marker changed after preflight: ${path}#${id}`);
        }
      }

      ownedBlocks[id] = {
        sha256: wanted.sha256,
        state: 'pending',
        ...(current && { previousSha256: current.sha256 }),
      };
      receipt.markers[path] = ownedBlocks;
      writeReceipt(root, receiptPath, receipt);
      const next = upsertManagedMarkerBlock(contents, wanted, path);
      atomicWritePrivateFile(root, target, next);
      const published = parseManagedMarkerBlocks(
        readPrivateFileNoFollow(root, target).toString('utf8'),
        path,
      ).get(id);
      if (!published || published.sha256 !== wanted.sha256) {
        fail(`published marker failed its digest check: ${path}#${id}`);
      }
      ownedBlocks[id] = {
        sha256: wanted.sha256,
        state: 'owned',
      };
      receipt.markers[path] = ownedBlocks;
      writeReceipt(root, receiptPath, receipt);
      result.written.push(`${path}#${id}`);
    }

    if (Object.keys(ownedBlocks).length === 0) {
      delete receipt.markers[path];
    } else {
      receipt.markers[path] = ownedBlocks;
    }
  }

  for (const directory of missingDirectories) {
    if (!existingDirectories.has(directory)) {
      receipt.createdDirectories.push(directory);
    }
  }
  receipt.createdDirectories = [...new Set(receipt.createdDirectories)];

  for (const [path, wanted] of desired) {
    const target = absoluteTarget(root, path);
    const prior = receipt.files[path];
    const digest = currentDigest(root, target);
    if (!wanted.claimExisting) {
      if (digest !== wanted.sha256) {
        fail(`retained existing file changed after preflight: ${path}`);
      }
      if (!prior) {
        // Already user-owned: deliberately leave it outside the receipt.
        continue;
      }
      const permitted = new Set([
        prior.sha256,
        ...(prior.previousSha256 ? [prior.previousSha256] : []),
      ]);
      if (!permitted.has(digest)) {
        // Drift transfers this exact file to the agent. Persist the release
        // immediately so a later plugin removal can never delete the edit.
        delete receipt.files[path];
        result.preserved.push(path);
        writeReceipt(root, receiptPath, receipt);
        continue;
      }
      try { chmodSync(target, wanted.mode); } catch { /* best effort outside POSIX */ }
      receipt.files[path] = {
        sha256: digest,
        state: 'owned',
        mode: wanted.mode,
      };
      result.unchanged.push(path);
      continue;
    }
    if (digest === wanted.sha256) {
      try { chmodSync(target, wanted.mode); } catch { /* best effort outside POSIX */ }
      receipt.files[path] = {
        sha256: wanted.sha256,
        state: 'owned',
        mode: wanted.mode,
      };
      result.unchanged.push(path);
      continue;
    }

    if (!prior && digest !== null) {
      const recovery = legacyFileRecoveries.get(path);
      if (!recovery || recovery.digest !== digest) {
        fail(`refusing to overwrite an unowned file during publication: ${path}`);
      }
      archiveLegacyFile(
        root,
        target,
        path,
        recovery.digest,
        recovery.recoveryPath,
        maxFileBytes,
      );
      result.archived.push({ path, recoveryPath: recovery.recoveryPath });
    }
    if (prior && digest !== null) {
      const permitted = new Set([
        prior.sha256,
        ...(prior.previousSha256 ? [prior.previousSha256] : []),
      ]);
      if (!permitted.has(digest)) {
        fail(`managed file changed after preflight: ${path}`);
      }
    }

    receipt.files[path] = {
      sha256: wanted.sha256,
      state: 'pending',
      mode: wanted.mode,
      ...(digest && { previousSha256: digest }),
    };
    writeReceipt(root, receiptPath, receipt);
    atomicWritePrivateFile(root, target, wanted.contents);
    try { chmodSync(target, wanted.mode); } catch { /* best effort outside POSIX */ }
    if (currentDigest(root, target) !== wanted.sha256) {
      fail(`published file failed its digest check: ${path}`);
    }
    receipt.files[path] = {
      sha256: wanted.sha256,
      state: 'owned',
      mode: wanted.mode,
    };
    writeReceipt(root, receiptPath, receipt);
    result.written.push(path);
  }

  const neededDirectories = new Set<string>();
  for (const path of desired.keys()) {
    for (const directory of parentDirectories(path)) neededDirectories.add(directory);
  }
  for (const [path, blocks] of desiredMarkers) {
    if (blocks.size === 0) continue;
    for (const directory of parentDirectories(path)) neededDirectories.add(directory);
  }
  const retainedDirectories: string[] = [];
  for (const directory of [...new Set(receipt.createdDirectories)].sort(
    (left, right) => right.split('/').length - left.split('/').length,
  )) {
    const target = assertCaseAndLinkSafePath(root, directory, 'directory');
    if (!existsSync(target)) continue;
    if (neededDirectories.has(directory)) {
      retainedDirectories.push(directory);
      continue;
    }
    if (readdirSync(target).length === 0) {
      rmdirSync(target);
    } else {
      // It now contains unowned/user data. Release the directory rather than
      // ever deleting its contents recursively.
      result.preserved.push(`${directory}/`);
    }
  }
  receipt.createdDirectories = retainedDirectories;
  writeReceipt(root, receiptPath, receipt);
  return result;
}
