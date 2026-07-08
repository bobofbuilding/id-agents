// SPDX-License-Identifier: MIT

import { pathToFileURL } from 'url';

import {
  formatReleaseSchemaResult,
  validateReleaseSchemaFromRepo,
} from './release-schema.js';

function rootFromArgs(args: string[]): string {
  const rootIndex = args.indexOf('--root');
  if (rootIndex === -1) return process.cwd();
  const root = args[rootIndex + 1];
  if (!root) throw new Error('Missing value for --root');
  return root;
}

export function main(args = process.argv.slice(2)): number {
  const validation = validateReleaseSchemaFromRepo(rootFromArgs(args));
  const formatted = formatReleaseSchemaResult(validation);
  if (validation.ok) {
    console.log(formatted);
    return 0;
  }
  console.error(formatted);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Release schema validation failed: ${message}`);
    process.exitCode = 1;
  }
}
