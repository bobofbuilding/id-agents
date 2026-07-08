// SPDX-License-Identifier: MIT

/**
 * Manager DB retention sweep (security review #6).
 *
 * Two caps, whichever is hit first per team, for each operational feed:
 *   - age:   delete rows older than `retentionDays` (default 7d)
 *   - count: keep at most `retentionCount` rows (default 100k); delete the
 *            oldest excess.
 *
 * Defaults can be overridden at process start via env:
 *   EVENT_LOG_RETENTION_DAYS     (positive integer, days)
 *   EVENT_LOG_RETENTION_COUNT    (positive integer, rows per team)
 *   NEWS_ITEMS_RETENTION_DAYS    (positive integer, days)
 *   NEWS_ITEMS_RETENTION_COUNT   (positive integer, rows per team)
 *   QUERIES_RETENTION_DAYS       (positive integer, days; terminal rows only)
 *   QUERIES_RETENTION_COUNT      (positive integer, terminal rows per team)
 *
 * The sweep loop is wired into the manager daemon at boot
 * (see startEventLogRetentionSweep in agent-manager-db.ts).
 */

import type { EventsRepository, NewsRepository, QueriesRepository, TeamsRepository } from '../db/db-service.js';

export const DEFAULT_RETENTION_DAYS = 7;
export const DEFAULT_RETENTION_COUNT = 100_000;
export const DEFAULT_NEWS_RETENTION_DAYS = 7;
export const DEFAULT_NEWS_RETENTION_COUNT = 50_000;
export const DEFAULT_QUERY_RETENTION_DAYS = 14;
export const DEFAULT_QUERY_RETENTION_COUNT = 10_000;
export const DEFAULT_RETENTION_INTERVAL_MS = 5 * 60 * 1000;

export interface RetentionConfig {
  retentionDays: number;
  retentionCount: number;
  newsRetentionDays: number;
  newsRetentionCount: number;
  queryRetentionDays: number;
  queryRetentionCount: number;
}

export interface RetentionSweepResult {
  agedDeleted: number;
  countDeleted: number;
  newsAgedDeleted: number;
  newsCountDeleted: number;
  queryAgedDeleted: number;
  queryCountDeleted: number;
  teamsScanned: number;
}

export interface RetentionTickInput {
  events: EventsRepository;
  news?: NewsRepository;
  queries?: Pick<QueriesRepository, 'pruneTerminalByAge' | 'pruneTerminalByCount'>;
  teams: TeamsRepository;
  now: number;
  config?: Partial<RetentionConfig>;
  log?: (line: string) => void;
}

export function resolveRetentionConfig(env: NodeJS.ProcessEnv = process.env): RetentionConfig {
  return {
    retentionDays: parsePositiveInt(env.EVENT_LOG_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
    retentionCount: parsePositiveInt(env.EVENT_LOG_RETENTION_COUNT, DEFAULT_RETENTION_COUNT),
    newsRetentionDays: parsePositiveInt(env.NEWS_ITEMS_RETENTION_DAYS, DEFAULT_NEWS_RETENTION_DAYS),
    newsRetentionCount: parsePositiveInt(env.NEWS_ITEMS_RETENTION_COUNT, DEFAULT_NEWS_RETENTION_COUNT),
    queryRetentionDays: parsePositiveInt(env.QUERIES_RETENTION_DAYS, DEFAULT_QUERY_RETENTION_DAYS),
    queryRetentionCount: parsePositiveInt(env.QUERIES_RETENTION_COUNT, DEFAULT_QUERY_RETENTION_COUNT),
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * One pass over every team. For each feed:
 *   1. Age sweep — delete rows older than the feed's age cap.
 *   2. Count sweep — if rows remain over the cap, delete the oldest excess.
 * Logs only when something was deleted.
 */
export async function sweepEventLogRetention(
  input: RetentionTickInput,
): Promise<RetentionSweepResult> {
  const base = resolveRetentionConfig();
  const cfg: RetentionConfig = {
    retentionDays: input.config?.retentionDays ?? base.retentionDays,
    retentionCount: input.config?.retentionCount ?? base.retentionCount,
    newsRetentionDays: input.config?.newsRetentionDays ?? base.newsRetentionDays,
    newsRetentionCount: input.config?.newsRetentionCount ?? base.newsRetentionCount,
    queryRetentionDays: input.config?.queryRetentionDays ?? base.queryRetentionDays,
    queryRetentionCount: input.config?.queryRetentionCount ?? base.queryRetentionCount,
  };
  const eventAgeCutoff = input.now - cfg.retentionDays * 24 * 60 * 60 * 1000;
  const newsAgeCutoff = input.now - cfg.newsRetentionDays * 24 * 60 * 60 * 1000;
  const queryAgeCutoff = input.now - cfg.queryRetentionDays * 24 * 60 * 60 * 1000;
  const log = input.log ?? ((line: string) => console.log(line));

  const result: RetentionSweepResult = {
    agedDeleted: 0,
    countDeleted: 0,
    newsAgedDeleted: 0,
    newsCountDeleted: 0,
    queryAgedDeleted: 0,
    queryCountDeleted: 0,
    teamsScanned: 0,
  };

  const teams = await input.teams.listTeams();
  for (const team of teams) {
    result.teamsScanned += 1;
    const aged = await input.events.pruneByAge(team.id, eventAgeCutoff);
    const count = await input.events.pruneByCount(team.id, cfg.retentionCount);
    const newsAged = input.news ? await input.news.pruneByAge(team.id, newsAgeCutoff) : 0;
    const newsCount = input.news ? await input.news.pruneByCount(team.id, cfg.newsRetentionCount) : 0;
    const queryAged = input.queries ? await input.queries.pruneTerminalByAge(team.id, queryAgeCutoff) : 0;
    const queryCount = input.queries ? await input.queries.pruneTerminalByCount(team.id, cfg.queryRetentionCount) : 0;
    result.agedDeleted += aged;
    result.countDeleted += count;
    result.newsAgedDeleted += newsAged;
    result.newsCountDeleted += newsCount;
    result.queryAgedDeleted += queryAged;
    result.queryCountDeleted += queryCount;
    if (aged > 0 || count > 0 || newsAged > 0 || newsCount > 0 || queryAged > 0 || queryCount > 0) {
      const newsPart = input.news ? ` news_aged=${newsAged} news_count=${newsCount}` : '';
      const queryPart = input.queries ? ` query_aged=${queryAged} query_count=${queryCount}` : '';
      log(`[wakeup-service] retention swept: aged=${aged} count=${count}${newsPart}${queryPart} team=${team.name}`);
    }
  }
  return result;
}

/**
 * Daemon-side wrapper. `start()` installs a `setInterval` that calls
 * `sweepEventLogRetention` every `intervalMs` (default 5 minutes); `stop()`
 * tears it down. Mirrors the `CheckinService` shape so the two background
 * loops are easy to compare in `agent-manager-db.ts`.
 */
export class RetentionService {
  private interval: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs: number;
  private readonly config: RetentionConfig;
  private readonly log: (line: string) => void;
  private readonly errorLog: (msg: string, err?: unknown) => void;

  constructor(
    private readonly db: { events: EventsRepository; news?: NewsRepository; queries?: Pick<QueriesRepository, 'pruneTerminalByAge' | 'pruneTerminalByCount'>; teams: TeamsRepository },
    opts: {
      intervalMs?: number;
      config?: Partial<RetentionConfig>;
      log?: (line: string) => void;
      errorLog?: (msg: string, err?: unknown) => void;
    } = {},
  ) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_RETENTION_INTERVAL_MS;
    const base = resolveRetentionConfig();
    this.config = {
      retentionDays: opts.config?.retentionDays ?? base.retentionDays,
      retentionCount: opts.config?.retentionCount ?? base.retentionCount,
      newsRetentionDays: opts.config?.newsRetentionDays ?? base.newsRetentionDays,
      newsRetentionCount: opts.config?.newsRetentionCount ?? base.newsRetentionCount,
      queryRetentionDays: opts.config?.queryRetentionDays ?? base.queryRetentionDays,
      queryRetentionCount: opts.config?.queryRetentionCount ?? base.queryRetentionCount,
    };
    this.log = opts.log ?? ((line) => console.log(line));
    this.errorLog =
      opts.errorLog ??
      ((msg, err) => console.error(`[wakeup-service] ${msg}`, err));
  }

  /** Start the periodic sweep. Idempotent. */
  start(): void {
    if (this.interval) return;
    const run = () => {
      if (this.running) return;
      this.running = true;
      this.tick(Date.now())
        .catch((err) => this.errorLog('retention tick failed', err))
        .finally(() => {
          this.running = false;
        });
    };
    this.interval = setInterval(run, this.intervalMs);
    this.interval.unref?.();
  }

  /** Stop the periodic sweep. Safe to call multiple times. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Single sweep pass. Public for tests. */
  async tick(now: number): Promise<RetentionSweepResult> {
    return sweepEventLogRetention({
      events: this.db.events,
      news: this.db.news,
      queries: this.db.queries,
      teams: this.db.teams,
      now,
      config: this.config,
      log: this.log,
    });
  }

  /** Exposed for tests / diagnostics. */
  getConfig(): RetentionConfig {
    return { ...this.config };
  }
}
