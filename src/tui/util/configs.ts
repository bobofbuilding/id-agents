import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export interface ConfigFileRow {
  name: string;
  relativePath: string;
  absolutePath: string;
  mtimeMs: number;
}

export function listConfigFiles(configsDir = path.join(process.cwd(), 'configs')): ConfigFileRow[] {
  if (!existsSync(configsDir)) return [];

  const root = path.resolve(configsDir);
  const rows: ConfigFileRow[] = [];
  walk(root, root, rows);
  rows.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return rows;
}

function walk(root: string, dir: string, rows: ConfigFileRow[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, absolutePath, rows);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.yaml')) continue;
    const st = statSync(absolutePath);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
    rows.push({
      name: path.basename(entry.name, '.yaml'),
      relativePath,
      absolutePath,
      mtimeMs: st.mtimeMs,
    });
  }
}
