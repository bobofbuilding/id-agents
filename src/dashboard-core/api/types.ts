// SPDX-License-Identifier: MIT
/**
 * Renderer-neutral manager DTO contracts.
 *
 * These describe the wire shapes returned by the id-agents manager. They must
 * stay free of any renderer concern (no Ink, React, or terminal types) so both
 * the TUI and the Electron dashboard can share one definition. The TUI keeps
 * importing them through `src/tui/api/types.ts`, which now re-exports this file.
 */

export interface AgentMetadata {
  runtime?: string;
  description?: string;
  effort?: string;
  heartbeat?: boolean;
  pid?: number;
  /** Profile bio from the manager catalog (config YAML floor; runtime-editable). */
  bio?: string;
  /** Named profile links/handles, e.g. { x: '@name', github: 'name', site: 'https://…' }. */
  handles?: Record<string, string>;
  [key: string]: unknown;
}

export interface Agent {
  id: string;
  name: string;
  alias?: string;
  // Display fields the manager sends for live agents but that the client must
  // not hard-require: minimal callers (and the command dispatch tests) supply
  // identity-only agent rows, and every TUI consumer already renders a
  // placeholder when these are absent. Marked optional so validation can
  // type-check them when present without rejecting valid identity-only rows.
  port?: number | null;
  status?: string;
  health?: string;
  model?: string;
  type?: string;
  url?: string | null;
  workingDirectory?: string | null;
  createdAt?: number;
  lastHealthCheck?: number;
  metadata?: AgentMetadata;
  teamName?: string;
  // Remote-endpoint fields (public-agent-remote runtime)
  deploymentShape?: 'local-process' | 'remote-endpoint';
  pid?: number | null;
  customer_domain?: string | null;
  public_endpoint_url?: string | null;
  ows_wallet?: string | null;
  idchain_domain?: string | null;
  ssh_target?: string | null;
  last_seen?: number | null;
  last_probed_at?: number | null;
  last_error?: string | null;
  consecutive_failures?: number;
}

export interface Team {
  // `name` is the only field every caller supplies and the only one the client
  // dereferences. `id`/`agentCount` are present in live manager payloads but
  // optional in the contract (identity-only team rows are valid, and the TUI
  // derives its counts from a separate map, not `agentCount`).
  name: string;
  id?: string;
  agentCount?: number;
  createdAt?: string;
}

export interface AgentsResponse {
  agents: Agent[];
}

export interface TeamsResponse {
  teams: Team[];
}

export interface NewsItem {
  type: string;
  timestamp: number;
  message?: string;
  data?: unknown;
}

export interface RemoteNewsResponse {
  ok: boolean;
  result?: { items?: NewsItem[] };
  error?: string;
}

export interface Task {
  name: string;
  uuid?: string;
  shortId?: string;
  title: string;
  description?: string | null;
  status: string;
  ownerName?: string | null;
  teamName?: string;
  linkedEvents?: string[];
  createdAt: number;
  updatedAt?: number;
  completedAt?: number | null;
}

export interface RemoteTasksResponse {
  ok: boolean;
  result?: { tasks?: Task[] };
  error?: string;
}

export interface Schedule {
  id: string;
  title: string;
  kind: 'heartbeat' | 'calendar' | string;
  active: boolean;
  deliveryMode?: string;
  sourceType?: string;
  targets: string[];
  intervalSeconds: number | null;
  timezone: string | null;
  localTimeSeconds: number | null;
  localDate: string | null;
  daysOfWeek: string | null;
  createdAt: number;
  teamName?: string;
  /** The prompt/message delivered when this schedule fires (calendar events). */
  message?: string;
}

export interface RemoteSchedulesResponse {
  ok: boolean;
  result?: { schedules?: Schedule[] };
  error?: string;
}

/**
 * Envelope returned by the manager's `/remote` proxy for every command.
 * `ok:false` carries a semantic `error`; `ok:true` carries `result`.
 */
export interface RemoteEnvelope<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

/* ------------------------------------------------------------------ */
/*  Library inventory (manager /library/* endpoints)                   */
/* ------------------------------------------------------------------ */

export type LibraryAgentShape = 'claude-native' | 'agents-md-native';

export interface LibraryAgentRow {
  name: string;
  shape: LibraryAgentShape;
  hasReadme: boolean;
  hasLicense: boolean;
  subfolders: string[];
  source_path: string;
  /**
   * README-first description from the manager. First body paragraph of
   * the entry's README.md, or null when no README is present.
   */
  description: string | null;
}

export interface LibraryAgentListResponse {
  libraryRoot: string | null;
  entries: LibraryAgentRow[];
  errors: Array<{ name: string; code: string; message: string }>;
}

export interface LibraryAgentDetailResponse extends LibraryAgentRow {
  memoryFile: string;
  readme: string | null;
  memory: string;
  bundledSkills: string[];
}

export interface LibrarySkillRow {
  name: string;
  hasSkillMd: boolean;
  source_path: string;
  /**
   * README-first description from the manager. SKILL.md frontmatter
   * `description:` first, then first body paragraph; null when neither
   * is available.
   */
  description: string | null;
}

export interface LibrarySkillListResponse {
  libraryRoot: string | null;
  entries: LibrarySkillRow[];
}

export interface LibrarySkillDetailResponse extends LibrarySkillRow {
  skillFile: string;
  skillName: string | null;
  description: string | null;
  bodyLength: number;
}

export interface LibraryTeamRow {
  name: string;
  hasReadme: boolean;
  hasLicense: boolean;
  hasTeamYaml: boolean;
  source_path: string;
  /**
   * README-first description from the manager. First body paragraph of
   * the team's README.md, or null when no README is present.
   */
  description: string | null;
}

export interface LibraryTeamListResponse {
  libraryRoot: string | null;
  entries: LibraryTeamRow[];
}

export interface LibraryTeamDetailResponse extends LibraryTeamRow {
  teamYamlFile: string;
  readme: string | null;
  teamYaml: string;
  declaredTeam: string | null;
  agents: string[];
}

export interface InstallLibraryTeamRequest {
  template: string;
  dest: string;
  force?: boolean;
}

export interface InstallLibraryTeamSuccess {
  ok: true;
  kind: 'team';
  template: string;
  dest: string;
  destPath: string;
  overwritten: boolean;
  declaredTeamBefore: string | null;
  declaredTeamAfter: string;
}

export interface InstallLibraryTeamFailure {
  ok: false;
  error: string;
  status: number;
  [k: string]: unknown;
}

export type InstallLibraryTeamResponse =
  | InstallLibraryTeamSuccess
  | InstallLibraryTeamFailure;
