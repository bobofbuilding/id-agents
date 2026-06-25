// SPDX-License-Identifier: MIT
/**
 * Agent-config v3 slice 7 — read-only library inventory helpers.
 *
 * Thin wrappers around the slice-1 enumerators in `./agent-library.ts`
 * that produce JSON-friendly response shapes for manager HTTP routes.
 * No shape detection is duplicated here; filesystem classification
 * stays in the enumerator. Everything beyond "is this a library entry"
 * — README / LICENSE presence, subfolder listings, SKILL.md frontmatter
 * — is metadata enrichment and lives here.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import {
  enumerateLibraryAgents,
  enumerateLibrarySkills,
  enumerateLibraryTeams,
  getLibraryPaths,
  type AgentLibraryShape,
  type LibraryAgentError,
} from './agent-library.js';

export interface AgentListEntry {
  name: string;
  shape: AgentLibraryShape;
  hasReadme: boolean;
  hasLicense: boolean;
  /** Immediate subdirectory names (non-dot) under the entry's directory. */
  subfolders: string[];
  /** Absolute filesystem path to the entry's directory. */
  source_path: string;
}

export interface AgentDetail extends AgentListEntry {
  /** Absolute path to the persona / memory markdown file. */
  memoryFile: string;
  /** README body, or null when no README.md is present. */
  readme: string | null;
  /** Raw CLAUDE.md body (claude-native) or sibling `<name>.md` body (agents-md-native). */
  memory: string;
  /** Names of bundled skills discovered under the entry's `skills/` subdir. */
  bundledSkills: string[];
}

export interface SkillListEntry {
  name: string;
  /**
   * Whether a SKILL.md file is present under the skill directory. Always
   * true for enumerated entries (the enumerator requires it) but included
   * in the contract so the TUI can render the check uniformly and so a
   * future caller that loosens the enumerator sees the flag.
   */
  hasSkillMd: boolean;
  /** Absolute filesystem path to the skill directory. */
  source_path: string;
  /** SKILL.md frontmatter `description` (catalog display), or null. */
  description?: string | null;
  /**
   * Tag list parsed from frontmatter `metadata.tags` (catalog filtering).
   * The agentskills.io spec has no first-class tags field, so tags live
   * under the `metadata` extension point as a comma-separated string or list.
   */
  tags?: string[];
  /** SKILL.md frontmatter `license`, or null. */
  license?: string | null;
}

/** Input for {@link createLibrarySkill}; mirrors the agentskills.io SKILL.md schema. */
export interface CreateSkillInput {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  /** Space-separated tool allow-list → frontmatter `allowed-tools`. */
  allowedTools?: string;
  /** Arbitrary string→string map → frontmatter `metadata` (holds tags, category…). */
  metadata?: Record<string, string>;
  /** Markdown instructions (body after the frontmatter). */
  body?: string;
  /** Permit replacing an existing skill of the same name. Default false. */
  overwrite?: boolean;
}

export interface CreateSkillResult {
  ok: boolean;
  /** HTTP status the route should answer with. */
  status: number;
  error?: string;
  entry?: SkillListEntry;
}

export interface SkillDetail extends SkillListEntry {
  /** Absolute path to the SKILL.md file. */
  skillFile: string;
  /** Frontmatter name field, or null if missing / unparsable. */
  skillName: string | null;
  /** Frontmatter description field, or null if missing / unparsable. */
  description: string | null;
  /** Character length of the SKILL.md body (post-frontmatter). */
  bodyLength: number;
}

export interface AgentListResult {
  /** Absolute library root, or null when the manager has no library configured. */
  libraryRoot: string | null;
  entries: AgentListEntry[];
  /** Discovery errors surfaced by the enumerator (mixed-shape, incomplete pair). */
  errors: LibraryAgentError[];
}

export interface SkillListResult {
  libraryRoot: string | null;
  entries: SkillListEntry[];
}

export interface TeamListEntry {
  name: string;
  hasReadme: boolean;
  hasLicense: boolean;
  hasTeamYaml: boolean;
  source_path: string;
  description: string | null;
}

export interface TeamDetail extends TeamListEntry {
  teamYamlFile: string;
  readme: string | null;
  teamYaml: string;
  declaredTeam: string | null;
  agents: string[];
}

export interface TeamListResult {
  libraryRoot: string | null;
  entries: TeamListEntry[];
}

export interface PluginListEntry {
  name: string;
  /** Whether a plugin.json manifest is present. */
  hasManifest: boolean;
  /** Manifest version, or null when absent. */
  version: string | null;
  /** Manifest description, or null when absent. */
  description: string | null;
  /** Absolute filesystem path to the plugin directory. */
  source_path: string;
  /** Manifest author name (string or `author.name`), or null. */
  author?: string | null;
  /**
   * Where the plugin comes from — repository / homepage / marketplace URL,
   * or the manifest `type` (e.g. 'local' → "bundled (local)" for plugins that
   * ship with the manager). Null when the manifest carries no origin hint.
   */
  source?: string | null;
}

export interface PluginListResult {
  /** Absolute plugins root (plugins/claude-code), or null when none exists. */
  pluginsRoot: string | null;
  entries: PluginListEntry[];
}

export interface PluginDetail extends PluginListEntry {
  /** Full plugin.json contents (best-effort), or null. */
  manifest: Record<string, unknown> | null;
  /** SKILL.md body if the plugin ships one at its root, else null. */
  skillBody: string | null;
}

/**
 * Default library-root resolution used by the manager HTTP endpoints.
 *
 * Consistent with slice-2's in-process default: the in-repo library lives
 * at `<repoRoot>/configs`. Operators can override with `ID_LIBRARY_ROOT`
 * to point at an out-of-tree library (e.g. the `public-agents/configs`
 * used by the slice-3 workspace-sync demos).
 *
 * Resolution order:
 *   1. process.env.ID_LIBRARY_ROOT when set and existing on disk
 *   2. <cwd>/configs when present
 *   3. null (no library configured)
 *
 * Returning null rather than throwing lets the routes answer with an
 * empty list instead of a 500, matching the brief's "no library
 * configured -> empty list rather than error" contract.
 */
export function resolveDefaultLibraryRoot(): string | null {
  const envRoot = process.env.ID_LIBRARY_ROOT;
  if (envRoot) {
    const resolved = path.resolve(envRoot);
    if (fs.existsSync(resolved)) return resolved;
  }
  const cwdRoot = path.resolve(process.cwd(), 'configs');
  if (fs.existsSync(cwdRoot)) return cwdRoot;
  return null;
}

function fileExists(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function dirExists(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function listSubfolders(dirPath: string): string[] {
  if (!dirExists(dirPath)) return [];
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name)
    .sort((a, b) => a.localeCompare(b));
}

function readFileIfExists(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

function bundledSkillNames(agentDir: string): string[] {
  const skillsDir = path.join(agentDir, 'skills');
  return enumerateLibrarySkills(skillsDir).map(e => e.name);
}

function decorateAgentEntry(
  name: string,
  shape: AgentLibraryShape,
  dirPath: string,
): AgentListEntry {
  return {
    name,
    shape,
    hasReadme: fileExists(path.join(dirPath, 'README.md')),
    hasLicense: fileExists(path.join(dirPath, 'LICENSE')),
    subfolders: listSubfolders(dirPath),
    source_path: dirPath,
  };
}

/** Normalize a frontmatter tags value (string "a, b" or list) to a clean array. */
function normalizeTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Read a skill's SKILL.md and pull catalog-facing metadata (description, tags, license). */
function readSkillCatalogMeta(skillFile: string): { description: string | null; tags: string[]; license: string | null } {
  const raw = readFileIfExists(skillFile);
  if (raw == null) return { description: null, tags: [], license: null };
  const { frontmatter } = parseSkillMd(raw);
  const metaRaw = frontmatter.metadata;
  const meta = metaRaw && typeof metaRaw === 'object' && !Array.isArray(metaRaw)
    ? (metaRaw as Record<string, unknown>)
    : {};
  // Tags live under metadata.tags (spec extension); accept a top-level `tags` too.
  const tags = normalizeTags(meta.tags ?? (frontmatter as Record<string, unknown>).tags);
  return {
    description: stringFieldOrNull(frontmatter, 'description'),
    tags,
    license: stringFieldOrNull(frontmatter, 'license'),
  };
}

function decorateSkillEntry(name: string, dirPath: string): SkillListEntry {
  const skillFile = path.join(dirPath, 'SKILL.md');
  const { description, tags, license } = readSkillCatalogMeta(skillFile);
  return {
    name,
    hasSkillMd: fileExists(skillFile),
    source_path: dirPath,
    description,
    tags,
    license,
  };
}

function parseSkillMd(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  // Frontmatter is the block between an opening '---' line and the next line
  // that is EXACTLY '---' (or '...') at column 0. Scanning line-by-line (rather
  // than a non-greedy regex) avoids mistaking an INDENTED '---' inside a YAML
  // block scalar — e.g. a markdown horizontal rule in a description — for the
  // closing fence, which would silently truncate the value.
  const lines = raw.split('\n');
  if (lines.length === 0 || lines[0].replace(/\r$/, '') !== '---') {
    return { frontmatter: {}, body: raw };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].replace(/\r$/, '');
    if (t === '---' || t === '...') { end = i; break; }
  }
  if (end === -1) return { frontmatter: {}, body: raw };
  const fmText = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n');
  let frontmatter: Record<string, unknown> = {};
  try {
    frontmatter = (yaml.load(fmText) as Record<string, unknown>) || {};
  } catch {
    frontmatter = {};
  }
  return { frontmatter, body };
}

function stringFieldOrNull(frontmatter: Record<string, unknown>, key: string): string | null {
  const v = frontmatter[key];
  return typeof v === 'string' ? v : null;
}

export function listLibraryAgents(libraryRoot: string | null): AgentListResult {
  if (!libraryRoot) {
    return { libraryRoot: null, entries: [], errors: [] };
  }
  const { agents } = getLibraryPaths(libraryRoot);
  const scan = enumerateLibraryAgents(agents);
  return {
    libraryRoot,
    entries: scan.entries.map(entry =>
      decorateAgentEntry(entry.name, entry.shape, entry.dirPath),
    ),
    errors: scan.errors,
  };
}

export function getLibraryAgent(
  libraryRoot: string | null,
  name: string,
): AgentDetail | null {
  if (!libraryRoot) return null;
  const { agents } = getLibraryPaths(libraryRoot);
  const scan = enumerateLibraryAgents(agents);
  const entry = scan.entries.find(e => e.name === name);
  if (!entry) return null;

  const base = decorateAgentEntry(entry.name, entry.shape, entry.dirPath);
  const readmePath = path.join(entry.dirPath, 'README.md');
  const memoryBody = readFileIfExists(entry.memoryFile) ?? '';

  return {
    ...base,
    memoryFile: entry.memoryFile,
    readme: readFileIfExists(readmePath),
    memory: memoryBody,
    bundledSkills: bundledSkillNames(entry.dirPath),
  };
}

export function listLibrarySkills(libraryRoot: string | null): SkillListResult {
  if (!libraryRoot) {
    return { libraryRoot: null, entries: [] };
  }
  const { skills } = getLibraryPaths(libraryRoot);
  const entries = enumerateLibrarySkills(skills);
  return {
    libraryRoot,
    entries: entries.map(entry => decorateSkillEntry(entry.name, entry.dirPath)),
  };
}

export function listLibraryTeams(libraryRoot: string | null): TeamListResult {
  if (!libraryRoot) {
    return { libraryRoot: null, entries: [] };
  }
  const { teams } = getLibraryPaths(libraryRoot);
  const entries = enumerateLibraryTeams(teams);
  return {
    libraryRoot,
    entries: entries.map((entry) => ({
      name: entry.name,
      hasReadme: fileExists(path.join(entry.dirPath, 'README.md')),
      hasLicense: fileExists(path.join(entry.dirPath, 'LICENSE')),
      hasTeamYaml: fileExists(entry.teamYamlFile),
      source_path: entry.dirPath,
      description: null,
    })),
  };
}

export function getLibraryTeam(libraryRoot: string | null, name: string): TeamDetail | null {
  if (!libraryRoot) return null;
  const { teams } = getLibraryPaths(libraryRoot);
  const entries = enumerateLibraryTeams(teams);
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) return null;
  const readme = readFileIfExists(path.join(entry.dirPath, 'README.md'));
  const teamYaml = readFileIfExists(entry.teamYamlFile) ?? '';
  let declaredTeam: string | null = null;
  let agents: string[] = [];
  try {
    const parsed = (yaml.load(teamYaml) as Record<string, unknown>) || {};
    declaredTeam = typeof parsed.team === 'string' ? parsed.team : null;
    if (Array.isArray(parsed.agents)) {
      agents = parsed.agents
        .map((item) => {
          if (!item || typeof item !== 'object') return '';
          const value = (item as Record<string, unknown>).name;
          return typeof value === 'string' ? value : '';
        })
        .filter(Boolean);
    }
  } catch {
    declaredTeam = null;
    agents = [];
  }
  return {
    name: entry.name,
    hasReadme: fileExists(path.join(entry.dirPath, 'README.md')),
    hasLicense: fileExists(path.join(entry.dirPath, 'LICENSE')),
    hasTeamYaml: fileExists(entry.teamYamlFile),
    source_path: entry.dirPath,
    description: null,
    teamYamlFile: entry.teamYamlFile,
    readme,
    teamYaml,
    declaredTeam,
    agents,
  };
}

/**
 * Resolve the plugins root for a given library root. Plugins live alongside
 * the repo (e.g. `<repo>/plugins/claude-code`), a sibling of `<repo>/configs`
 * (the usual library root). Resolution order:
 *   1. ID_PLUGINS_ROOT env when set and existing
 *   2. <libraryRoot>/../plugins/claude-code
 *   3. <libraryRoot>/plugins/claude-code (library that nests plugins)
 *   4. null
 */
export function resolvePluginsRoot(libraryRoot: string | null): string | null {
  const envRoot = process.env.ID_PLUGINS_ROOT;
  if (envRoot) {
    const resolved = path.resolve(envRoot);
    if (dirExists(resolved)) return resolved;
  }
  if (!libraryRoot) return null;
  const sibling = path.resolve(libraryRoot, '..', 'plugins', 'claude-code');
  if (dirExists(sibling)) return sibling;
  const nested = path.resolve(libraryRoot, 'plugins', 'claude-code');
  if (dirExists(nested)) return nested;
  return null;
}

function readPluginManifest(pluginDir: string): Record<string, unknown> | null {
  // Merge the simplified top-level plugin.json with the canonical Claude Code
  // manifest (.claude-plugin/plugin.json). Curated top-level fields win
  // (description/version), while the canonical manifest fills in provenance
  // (author, repository, homepage) the top-level usually omits — e.g.
  // frontend-design's Anthropic authorship lives only in .claude-plugin.
  const read = (rel: string): Record<string, unknown> | null => {
    const raw = readFileIfExists(path.join(pluginDir, rel));
    if (!raw) return null;
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  };
  const top = read('plugin.json');
  const canonical = read(path.join('.claude-plugin', 'plugin.json'));
  if (!top && !canonical) return null;
  return { ...(canonical ?? {}), ...(top ?? {}) };
}

/** Best-effort author display from a plugin manifest (string or `author.name`). */
function manifestAuthor(manifest: Record<string, unknown> | null): string | null {
  if (!manifest) return null;
  const a = manifest.author;
  if (typeof a === 'string') return a.trim() || null;
  if (a && typeof a === 'object') {
    const name = (a as Record<string, unknown>).name;
    if (typeof name === 'string') return name.trim() || null;
  }
  return null;
}

/** Best-effort origin display: repository/homepage/marketplace URL, else the manifest type. */
function manifestSource(manifest: Record<string, unknown> | null): string | null {
  if (!manifest) return null;
  const repo = manifest.repository;
  if (typeof repo === 'string' && repo.trim()) return repo.trim();
  if (repo && typeof repo === 'object') {
    const url = (repo as Record<string, unknown>).url;
    if (typeof url === 'string' && url.trim()) return url.trim();
  }
  for (const k of ['homepage', 'marketplace', 'provider']) {
    const v = manifest[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const type = manifest.type;
  if (typeof type === 'string' && type.trim()) return type === 'local' ? 'bundled (local)' : type.trim();
  return null;
}

function decoratePluginEntry(name: string, dirPath: string): PluginListEntry {
  const manifest = readPluginManifest(dirPath);
  return {
    name,
    hasManifest: manifest !== null,
    version: manifest && typeof manifest.version === 'string' ? manifest.version : null,
    description: manifest && typeof manifest.description === 'string' ? manifest.description : null,
    source_path: dirPath,
    author: manifestAuthor(manifest),
    source: manifestSource(manifest),
  };
}

export function listLibraryPlugins(libraryRoot: string | null): PluginListResult {
  const pluginsRoot = resolvePluginsRoot(libraryRoot);
  if (!pluginsRoot) return { pluginsRoot: null, entries: [] };
  const entries = fs.readdirSync(pluginsRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => decoratePluginEntry(d.name, path.join(pluginsRoot, d.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { pluginsRoot, entries };
}

export function getLibraryPlugin(libraryRoot: string | null, name: string): PluginDetail | null {
  const pluginsRoot = resolvePluginsRoot(libraryRoot);
  if (!pluginsRoot) return null;
  // `name` comes straight from a route param — reject anything that isn't a
  // plain directory name, then assert the resolved path stays under the root.
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') return null;
  const dirPath = path.resolve(pluginsRoot, name);
  if (dirPath !== pluginsRoot && !dirPath.startsWith(pluginsRoot + path.sep)) return null;
  if (!dirExists(dirPath)) return null;
  const base = decoratePluginEntry(name, dirPath);
  return {
    ...base,
    manifest: readPluginManifest(dirPath),
    skillBody: readFileIfExists(path.join(dirPath, 'SKILL.md')),
  };
}

/**
 * agentskills.io `name` rule: 1–64 chars, lowercase alphanumerics and single
 * hyphens, no leading/trailing/consecutive hyphens. Also functions as the
 * path-traversal guard since it forbids `/`, `\`, `.` and `..`.
 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Create a new library skill on disk as an agentskills.io-compliant folder
 * (`<skillsDir>/<name>/SKILL.md`). Validates the frontmatter contract, refuses
 * path traversal, and (by default) refuses to overwrite an existing skill.
 * Returns a JSON-friendly result with the HTTP status the route should use.
 */
export function createLibrarySkill(libraryRoot: string | null, input: CreateSkillInput): CreateSkillResult {
  if (!libraryRoot) return { ok: false, status: 409, error: 'no_library_root' };

  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 64 || !SKILL_NAME_RE.test(name)) {
    return { ok: false, status: 400, error: 'invalid_name' };
  }
  const description = typeof input?.description === 'string' ? input.description.trim() : '';
  if (!description || description.length > 1024) {
    return { ok: false, status: 400, error: 'invalid_description' };
  }
  if (input.license != null && (typeof input.license !== 'string' || input.license.length > 200)) {
    return { ok: false, status: 400, error: 'invalid_license' };
  }
  if (input.compatibility != null && (typeof input.compatibility !== 'string' || input.compatibility.length > 500)) {
    return { ok: false, status: 400, error: 'invalid_compatibility' };
  }
  if (input.allowedTools != null && (typeof input.allowedTools !== 'string' || input.allowedTools.length > 500)) {
    return { ok: false, status: 400, error: 'invalid_allowed_tools' };
  }

  let metadata: Record<string, string> | undefined;
  if (input.metadata != null) {
    if (typeof input.metadata !== 'object' || Array.isArray(input.metadata)) {
      return { ok: false, status: 400, error: 'invalid_metadata' };
    }
    const keys = Object.keys(input.metadata);
    if (keys.length > 32) return { ok: false, status: 400, error: 'too_much_metadata' };
    const out: Record<string, string> = {};
    for (const k of keys) {
      const v = (input.metadata as Record<string, unknown>)[k];
      if (typeof k !== 'string' || !k || k.length > 64) return { ok: false, status: 400, error: 'invalid_metadata_key' };
      if (typeof v !== 'string' || v.length > 512) return { ok: false, status: 400, error: 'invalid_metadata_value' };
      out[k] = v;
    }
    if (Object.keys(out).length) metadata = out;
  }

  const body = typeof input.body === 'string' ? input.body : '';
  if (body.length > 100_000) return { ok: false, status: 400, error: 'body_too_large' };

  const skillsDir = getLibraryPaths(libraryRoot).skills;
  const dirPath = path.resolve(skillsDir, name);
  // Defense in depth: the resolved skill dir must sit directly under skillsDir.
  if (path.dirname(dirPath) !== path.resolve(skillsDir)) {
    return { ok: false, status: 400, error: 'invalid_name' };
  }
  // Reject a symlink (or any non-directory) pre-planted at the destination —
  // path.resolve above does not dereference symlinks, so a symlinked
  // <skillsDir>/<name> would otherwise let the write escape the library.
  try {
    const st = fs.lstatSync(dirPath);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return { ok: false, status: 400, error: 'invalid_name' };
    }
  } catch { /* ENOENT: nothing there yet — fine, mkdir creates it below */ }
  // Verify symlink-resolved containment of the (existing) parent under skillsDir.
  try {
    if (fs.realpathSync(path.dirname(dirPath)) !== fs.realpathSync(skillsDir)) {
      return { ok: false, status: 400, error: 'invalid_name' };
    }
  } catch { /* skillsDir not created yet — the dirname string check already held */ }
  const skillFile = path.join(dirPath, 'SKILL.md');
  if (fileExists(skillFile) && !input.overwrite) {
    return { ok: false, status: 409, error: 'already_exists' };
  }

  // Build frontmatter in spec order, then the markdown body.
  const fm: Record<string, unknown> = { name, description };
  if (input.license && input.license.trim()) fm.license = input.license.trim();
  if (input.compatibility && input.compatibility.trim()) fm.compatibility = input.compatibility.trim();
  if (input.allowedTools && input.allowedTools.trim()) fm['allowed-tools'] = input.allowedTools.trim();
  if (metadata) fm.metadata = metadata;
  const frontmatter = yaml.dump(fm, { sortKeys: false, lineWidth: -1, quotingType: '"' });
  const content = `---\n${frontmatter}---\n\n${body.trim() ? body.trim() : `# ${name}\n\n${description}`}\n`;

  try {
    fs.mkdirSync(dirPath, { recursive: true });
    // O_NOFOLLOW: refuse to write through a symlinked SKILL.md (ELOOP), the one
    // file-level traversal the directory checks above don't cover on overwrite.
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
    const fd = fs.openSync(skillFile, flags, 0o644);
    try {
      fs.writeFileSync(fd, content, { encoding: 'utf-8' });
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return { ok: false, status: 500, error: (e as Error)?.message || 'write_failed' };
  }
  return { ok: true, status: 201, entry: decorateSkillEntry(name, dirPath) };
}

/**
 * Delete a library skill folder (<skillsDir>/<name>). Mirrors the create-path
 * safety: charset-validates the name (broad enough to match any enumerable
 * skill), refuses symlinks, and verifies real containment under skillsDir
 * before removing. Requires the dir to actually be a skill (has SKILL.md).
 */
export function deleteLibrarySkill(libraryRoot: string | null, name: string): { ok: boolean; status: number; error?: string; removed?: string } {
  if (!libraryRoot) return { ok: false, status: 409, error: 'no_library_root' };
  const n = typeof name === 'string' ? name.trim() : '';
  // Broad enough to match anything enumerateLibrarySkills accepts; the leading
  // alphanumeric + no '/' means '.'/'..'/traversal can't pass.
  if (!n || n.length > 64 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(n)) {
    return { ok: false, status: 400, error: 'invalid_name' };
  }
  const skillsDir = getLibraryPaths(libraryRoot).skills;
  const dirPath = path.resolve(skillsDir, n);
  if (path.dirname(dirPath) !== path.resolve(skillsDir)) {
    return { ok: false, status: 400, error: 'invalid_name' };
  }
  let st: fs.Stats;
  try { st = fs.lstatSync(dirPath); } catch { return { ok: false, status: 404, error: 'not_found' }; }
  if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, status: 400, error: 'invalid_name' };
  if (!fileExists(path.join(dirPath, 'SKILL.md'))) return { ok: false, status: 404, error: 'not_found' };
  try {
    if (fs.realpathSync(path.dirname(dirPath)) !== fs.realpathSync(skillsDir)) {
      return { ok: false, status: 400, error: 'invalid_name' };
    }
  } catch { /* skillsDir resolution issue — the string check above already held */ }
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, status: 500, error: (e as Error)?.message || 'delete_failed' };
  }
  return { ok: true, status: 200, removed: n };
}

export function getLibrarySkill(
  libraryRoot: string | null,
  name: string,
): SkillDetail | null {
  if (!libraryRoot) return null;
  const { skills } = getLibraryPaths(libraryRoot);
  const entries = enumerateLibrarySkills(skills);
  const entry = entries.find(e => e.name === name);
  if (!entry) return null;

  const base = decorateSkillEntry(entry.name, entry.dirPath);
  const raw = readFileIfExists(entry.skillFile) ?? '';
  const { frontmatter, body } = parseSkillMd(raw);

  return {
    ...base,
    skillFile: entry.skillFile,
    skillName: stringFieldOrNull(frontmatter, 'name'),
    description: stringFieldOrNull(frontmatter, 'description'),
    bodyLength: body.length,
  };
}
