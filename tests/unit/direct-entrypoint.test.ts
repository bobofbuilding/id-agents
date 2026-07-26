// SPDX-License-Identifier: MIT

import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isDirectEntrypoint } from '../../src/lib/direct-entrypoint.js';

describe('direct entrypoint detection', () => {
  it('matches consumer bundle paths containing URL-escaped characters', () => {
    const entry = join(
      process.cwd(),
      'ID Agents #100%.app',
      'Contents',
      'é-runtime',
      'Resources',
      'idacc-runtime',
      'manager',
      'dist',
      'local-agent-server.js',
    );

    expect(isDirectEntrypoint(pathToFileURL(entry).href, entry)).toBe(true);
    expect(
      isDirectEntrypoint(pathToFileURL(entry).href, relative(process.cwd(), entry)),
    ).toBe(true);
  });

  it('rejects missing and different entry scripts', () => {
    const moduleEntry = join(process.cwd(), 'dist', 'local-agent-server.js');
    expect(isDirectEntrypoint(pathToFileURL(moduleEntry).href, undefined)).toBe(false);
    expect(
      isDirectEntrypoint(
        pathToFileURL(moduleEntry).href,
        join(process.cwd(), 'dist', 'id-agents-cli.js'),
      ),
    ).toBe(false);
  });
});
