// SPDX-License-Identifier: MIT

import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_WINDOWS_PATH_EXT = '.COM;.EXE;.BAT;.CMD';

export interface ExecutableResolutionOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
  isExecutable?: (candidate: string, platform: NodeJS.Platform) => boolean;
}

function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const exact = env[name];
  if (exact !== undefined) return exact;
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function defaultIsExecutable(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    return platform === 'win32' || (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function executableExtensions(
  platform: NodeJS.Platform = process.platform,
  pathExt = environmentValue(process.env, 'PATHEXT'),
): string[] {
  if (platform !== 'win32') return [''];
  return Array.from(new Set(
    (pathExt || DEFAULT_WINDOWS_PATH_EXT)
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => `${value.startsWith('.') ? '' : '.'}${value}`.toLowerCase()),
  ));
}

export function executableCandidatePaths(
  directory: string,
  command: string,
  options: Pick<ExecutableResolutionOptions, 'platform' | 'env'> = {},
): string[] {
  const platform = options.platform ?? process.platform;
  const api = pathApi(platform);
  const env = options.env ?? process.env;
  const extensions = platform === 'win32' && !api.extname(command)
    ? executableExtensions(platform, environmentValue(env, 'PATHEXT'))
    : [''];
  return extensions.map((extension) => api.join(directory, `${command}${extension}`));
}

/**
 * Resolve one executable using the target platform's PATH delimiter and
 * Windows PATHEXT semantics. Explicit paths are accepted only when they exist.
 */
export function resolveExecutable(
  command: string,
  options: ExecutableResolutionOptions = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const api = pathApi(platform);
  const env = options.env ?? process.env;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const cwd = options.cwd ?? process.cwd();
  const hasPathSeparator = command.includes('/') || command.includes('\\');

  if (api.isAbsolute(command) || hasPathSeparator) {
    const base = api.isAbsolute(command) ? command : api.resolve(cwd, command);
    const directory = api.dirname(base);
    const binary = api.basename(base);
    return executableCandidatePaths(directory, binary, { platform, env })
      .find((candidate) => isExecutable(candidate, platform));
  }

  const pathEnv = environmentValue(env, 'PATH') || '';
  for (const rawDirectory of pathEnv.split(api.delimiter)) {
    const directory = rawDirectory.trim().replace(/^"(.*)"$/, '$1');
    if (!directory) continue;
    const found = executableCandidatePaths(directory, command, { platform, env })
      .find((candidate) => isExecutable(candidate, platform));
    if (found) return found;
  }
  return undefined;
}

export function executableRequiresShell(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable);
}
