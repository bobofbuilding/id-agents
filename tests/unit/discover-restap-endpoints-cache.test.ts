// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock('node-fetch', () => ({
  default: fetchMock,
}));

const { discoverRestAPEndpoints } = await import('../../src/agent-manager-db.js');

describe('discoverRestAPEndpoints cache debounce', () => {
  afterEach(() => {
    fetchMock.mockReset();
    vi.restoreAllMocks();
  });

  it('shares a single in-flight fetch and reuses the fresh cache entry', async () => {
    const catalog = {
      endpoints: {
        talk: '/talk-v2',
        news: '/news-v2',
        schedule: '/schedule-v2',
      },
    };

    let resolveFetch!: (value: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const baseEndpoint = 'http://cache-debounce.example.test';
    fetchMock.mockImplementation(() => fetchPromise as Promise<Response>);

    const first = discoverRestAPEndpoints(baseEndpoint);
    const second = discoverRestAPEndpoints(baseEndpoint);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(new Response(JSON.stringify(catalog), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(first).resolves.toEqual({
      talk: '/talk-v2',
      news: '/news-v2',
      schedule: '/schedule-v2',
    });
    await expect(second).resolves.toEqual({
      talk: '/talk-v2',
      news: '/news-v2',
      schedule: '/schedule-v2',
    });

    const third = await discoverRestAPEndpoints(baseEndpoint);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(third).toEqual({
      talk: '/talk-v2',
      news: '/news-v2',
      schedule: '/schedule-v2',
    });
  });
});
