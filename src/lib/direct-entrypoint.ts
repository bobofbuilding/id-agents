// SPDX-License-Identifier: MIT

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Node exposes the entry script as a filesystem path while `import.meta.url`
 * is a URL. Compare normalized URLs so spaces and other escaped path
 * characters work inside consumer application bundles on every platform.
 */
export function isDirectEntrypoint(
  moduleUrl: string,
  argvEntry: string | undefined = process.argv[1],
): boolean {
  if (!argvEntry) return false;
  try {
    return pathToFileURL(resolve(argvEntry)).href === moduleUrl;
  } catch {
    return false;
  }
}
