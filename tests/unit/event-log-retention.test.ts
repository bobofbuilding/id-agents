// SPDX-License-Identifier: MIT

/**
 * Unit tests for the event_log retention sweep
 * (output/security-review-wakeup-service.md audit #6).
 *
 * Drives `sweepEventLogRetention` against a stubbed events repo so we can
 * assert: the age cutoff is computed from `now - retentionDays`, the count
 * cap is forwarded as `keepCount`, the sweep iterates every team returned
 * by `teams.listTeams()`, and the log line only fires when something was
 * actually deleted.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NEWS_RETENTION_COUNT,
  DEFAULT_NEWS_RETENTION_DAYS,
  DEFAULT_RETENTION_COUNT,
  DEFAULT_RETENTION_DAYS,
  resolveRetentionConfig,
  sweepEventLogRetention,
} from '../../src/wakeup-service/retention.js';

interface StubCall {
  repo: 'events' | 'news';
  fn: 'pruneByAge' | 'pruneByCount';
  teamId: string;
  arg: number;
}

function makeStubEvents(returns: { aged?: Record<string, number>; count?: Record<string, number> } = {}) {
  const calls: StubCall[] = [];
  return {
    calls,
    repo: {
      async insert() { return { seq: 0 }; },
      async query() { return []; },
      async earliestSeq() { return null; },
      async latestSeq() { return null; },
      async pruneByAge(teamId: string, beforeOccurredAt: number) {
        calls.push({ repo: 'events', fn: 'pruneByAge', teamId, arg: beforeOccurredAt });
        return returns.aged?.[teamId] ?? 0;
      },
      async pruneByCount(teamId: string, keepCount: number) {
        calls.push({ repo: 'events', fn: 'pruneByCount', teamId, arg: keepCount });
        return returns.count?.[teamId] ?? 0;
      },
      async countForTeam() { return 0; },
    },
  };
}

function makeStubNews(returns: { aged?: Record<string, number>; count?: Record<string, number> } = {}) {
  const calls: StubCall[] = [];
  return {
    calls,
    repo: {
      async add() {},
      async poll() { return []; },
      async pollSummary() { return []; },
      async pollByOwner() { return []; },
      async pollSinceId() { return []; },
      async pollSinceIdByOwner() { return []; },
      async getRecent() { return []; },
      async fetchForArchive() { return []; },
      async deleteArchived() {},
      async pruneByAge(teamId: string, beforeTimestamp: number) {
        calls.push({ repo: 'news', fn: 'pruneByAge', teamId, arg: beforeTimestamp });
        return returns.aged?.[teamId] ?? 0;
      },
      async pruneByCount(teamId: string, keepCount: number) {
        calls.push({ repo: 'news', fn: 'pruneByCount', teamId, arg: keepCount });
        return returns.count?.[teamId] ?? 0;
      },
      async countForTeam() { return 0; },
    },
  };
}

function makeStubTeams(teams: Array<{ id: string; name: string }>) {
  return {
    async listTeams() {
      return teams.map((t) => ({
        id: t.id,
        name: t.name,
        config: {},
        port_start: 0,
        port_end: 0,
        created_at: '2026-01-01',
      }));
    },
  } as any;
}

describe('resolveRetentionConfig', () => {
  it('uses defaults when env vars are unset', () => {
    const cfg = resolveRetentionConfig({} as any);
    expect(cfg.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(cfg.retentionCount).toBe(DEFAULT_RETENTION_COUNT);
    expect(cfg.newsRetentionDays).toBe(DEFAULT_NEWS_RETENTION_DAYS);
    expect(cfg.newsRetentionCount).toBe(DEFAULT_NEWS_RETENTION_COUNT);
  });

  it('reads positive integer overrides from env', () => {
    const cfg = resolveRetentionConfig({
      EVENT_LOG_RETENTION_DAYS: '14',
      EVENT_LOG_RETENTION_COUNT: '50',
      NEWS_ITEMS_RETENTION_DAYS: '3',
      NEWS_ITEMS_RETENTION_COUNT: '5000',
    } as any);
    expect(cfg.retentionDays).toBe(14);
    expect(cfg.retentionCount).toBe(50);
    expect(cfg.newsRetentionDays).toBe(3);
    expect(cfg.newsRetentionCount).toBe(5000);
  });

  it('falls back to defaults on garbage / non-positive env values', () => {
    const cfg = resolveRetentionConfig({
      EVENT_LOG_RETENTION_DAYS: 'banana',
      EVENT_LOG_RETENTION_COUNT: '-5',
      NEWS_ITEMS_RETENTION_DAYS: '0',
      NEWS_ITEMS_RETENTION_COUNT: 'banana',
    } as any);
    expect(cfg.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(cfg.retentionCount).toBe(DEFAULT_RETENTION_COUNT);
    expect(cfg.newsRetentionDays).toBe(DEFAULT_NEWS_RETENTION_DAYS);
    expect(cfg.newsRetentionCount).toBe(DEFAULT_NEWS_RETENTION_COUNT);
  });
});

describe('sweepEventLogRetention', () => {
  it('passes ageCutoff = now - retentionDays and forwards retentionCount per team', async () => {
    const stub = makeStubEvents();
    const teams = makeStubTeams([
      { id: 'team-a', name: 'alpha' },
      { id: 'team-b', name: 'beta' },
    ]);
    const now = 1_777_300_000_000;
    await sweepEventLogRetention({
      events: stub.repo as any,
      teams,
      now,
      config: { retentionDays: 7, retentionCount: 100 },
    });

    const expectedCutoff = now - 7 * 24 * 60 * 60 * 1000;
    expect(stub.calls).toEqual([
      { repo: 'events', fn: 'pruneByAge', teamId: 'team-a', arg: expectedCutoff },
      { repo: 'events', fn: 'pruneByCount', teamId: 'team-a', arg: 100 },
      { repo: 'events', fn: 'pruneByAge', teamId: 'team-b', arg: expectedCutoff },
      { repo: 'events', fn: 'pruneByCount', teamId: 'team-b', arg: 100 },
    ]);
  });

  it('sweeps news rows with the news-specific age and count caps when supplied', async () => {
    const events = makeStubEvents();
    const news = makeStubNews();
    const teams = makeStubTeams([{ id: 'team-a', name: 'alpha' }]);
    const now = 1_777_300_000_000;
    await sweepEventLogRetention({
      events: events.repo as any,
      news: news.repo as any,
      teams,
      now,
      config: { retentionDays: 7, retentionCount: 100, newsRetentionDays: 2, newsRetentionCount: 25 },
    });

    expect(events.calls).toEqual([
      { repo: 'events', fn: 'pruneByAge', teamId: 'team-a', arg: now - 7 * 24 * 60 * 60 * 1000 },
      { repo: 'events', fn: 'pruneByCount', teamId: 'team-a', arg: 100 },
    ]);
    expect(news.calls).toEqual([
      { repo: 'news', fn: 'pruneByAge', teamId: 'team-a', arg: now - 2 * 24 * 60 * 60 * 1000 },
      { repo: 'news', fn: 'pruneByCount', teamId: 'team-a', arg: 25 },
    ]);
  });

  it('aggregates deletion counts across teams', async () => {
    const stub = makeStubEvents({
      aged: { 'team-a': 3, 'team-b': 0 },
      count: { 'team-a': 0, 'team-b': 5 },
    });
    const teams = makeStubTeams([
      { id: 'team-a', name: 'alpha' },
      { id: 'team-b', name: 'beta' },
    ]);
    const result = await sweepEventLogRetention({
      events: stub.repo as any,
      teams,
      now: 1_777_300_000_000,
      config: { retentionDays: 7, retentionCount: 100 },
    });
    expect(result).toEqual({ agedDeleted: 3, countDeleted: 5, newsAgedDeleted: 0, newsCountDeleted: 0, teamsScanned: 2 });
  });

  it('aggregates news deletion counts across teams', async () => {
    const events = makeStubEvents();
    const news = makeStubNews({
      aged: { 'team-a': 4, 'team-b': 0 },
      count: { 'team-a': 0, 'team-b': 6 },
    });
    const teams = makeStubTeams([
      { id: 'team-a', name: 'alpha' },
      { id: 'team-b', name: 'beta' },
    ]);
    const result = await sweepEventLogRetention({
      events: events.repo as any,
      news: news.repo as any,
      teams,
      now: 1_777_300_000_000,
      config: { retentionDays: 7, retentionCount: 100, newsRetentionDays: 7, newsRetentionCount: 100 },
    });
    expect(result).toEqual({ agedDeleted: 0, countDeleted: 0, newsAgedDeleted: 4, newsCountDeleted: 6, teamsScanned: 2 });
  });

  it('logs only when a team actually deleted something', async () => {
    const stub = makeStubEvents({
      aged: { 'team-a': 2, 'team-b': 0 },
      count: { 'team-a': 0, 'team-b': 0 },
    });
    const teams = makeStubTeams([
      { id: 'team-a', name: 'alpha' },
      { id: 'team-b', name: 'beta' },
    ]);
    const lines: string[] = [];
    await sweepEventLogRetention({
      events: stub.repo as any,
      teams,
      now: 1_777_300_000_000,
      config: { retentionDays: 7, retentionCount: 100 },
      log: (line) => lines.push(line),
    });
    expect(lines).toEqual([
      '[wakeup-service] retention swept: aged=2 count=0 team=alpha',
    ]);
  });

  it('is a no-op when no teams exist', async () => {
    const stub = makeStubEvents();
    const result = await sweepEventLogRetention({
      events: stub.repo as any,
      teams: makeStubTeams([]),
      now: Date.now(),
      config: { retentionDays: 7, retentionCount: 100 },
    });
    expect(result).toEqual({ agedDeleted: 0, countDeleted: 0, newsAgedDeleted: 0, newsCountDeleted: 0, teamsScanned: 0 });
    expect(stub.calls).toEqual([]);
  });
});
