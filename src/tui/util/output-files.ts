import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export interface OutputFileRow {
  name: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
}

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.log',
  '.csv',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.sh',
  '.sql',
  '.toml',
  '.ini',
  '.html',
  '.htm',
  '.xml',
  '.svg',
  '.conf',
  '.diff',
  '.patch',
  '.env',
]);

export function isTextOutputFile(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return ext === '' || TEXT_EXTENSIONS.has(ext);
}

export function outputDirForWorkingDirectory(workingDirectory: string | null | undefined): string | null {
  if (!workingDirectory) return null;
  return path.join(workingDirectory, 'output');
}

export function listOutputFiles(workingDirectory: string | null | undefined): OutputFileRow[] {
  const outputDir = outputDirForWorkingDirectory(workingDirectory);
  if (!outputDir || !existsSync(outputDir)) return [];

  const rows: OutputFileRow[] = [];
  for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolutePath = path.join(outputDir, entry.name);
    const st = statSync(absolutePath);
    rows.push({
      name: entry.name,
      absolutePath,
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  return rows;
}

export function readOutputFileDetail(file: OutputFileRow): string {
  if (!isTextOutputFile(file.name)) {
    return `(binary file: ${path.basename(file.name)}, ${formatBytes(file.size)})`;
  }
  return readFileSync(file.absolutePath, 'utf8');
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}
