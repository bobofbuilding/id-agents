// SPDX-License-Identifier: MIT

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PERSONAL_ABSOLUTE_PATH =
  /(?:\/Users\/[A-Za-z0-9._-]+\/|\/home\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\)/;

function textFiles(entry: string): string[] {
  if (!fs.existsSync(entry)) return [];
  const stat = fs.lstatSync(entry);
  if (stat.isSymbolicLink()) return [];
  if (stat.isFile()) return [entry];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(entry)
    .flatMap((name) => textFiles(path.join(entry, name)));
}

describe('consumer package neutrality', () => {
  it('contains no developer-specific absolute home paths in published assets', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
    ) as { files?: string[] };
    const staticEntries = (packageJson.files || [])
      .filter((entry) => !entry.startsWith('dist/'))
      .map((entry) => entry.replace(/\/\*\*\/\*$/, ''));
    const violations: string[] = [];
    for (const entry of staticEntries) {
      for (const file of textFiles(path.join(root, entry))) {
        const stat = fs.statSync(file);
        if (stat.size > 4 * 1024 * 1024) continue;
        const contents = fs.readFileSync(file, 'utf8');
        if (PERSONAL_ABSOLUTE_PATH.test(contents)) {
          violations.push(path.relative(root, file));
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
