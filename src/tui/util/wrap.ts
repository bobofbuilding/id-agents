export type TextWrapMode = 'truncate-end' | 'wrap';

export const DEFAULT_TEXT_WRAP_MODE: TextWrapMode = 'truncate-end';
export const FIXED_WINDOW_TEXT_WRAP_MODE: TextWrapMode = 'truncate-end';

export function textWrapMode(wrapEnabled: boolean): TextWrapMode {
  return wrapEnabled ? 'wrap' : DEFAULT_TEXT_WRAP_MODE;
}

export function toggleWrapEnabled(current: boolean): boolean {
  return !current;
}

export function isWrapToggleInput(input: string): boolean {
  return input === 'w';
}

export function fixedWindowWrapMode(): TextWrapMode {
  return FIXED_WINDOW_TEXT_WRAP_MODE;
}

export function wrapLinesForViewport(
  lines: string[],
  width: number,
  wrapMode: TextWrapMode,
): string[] {
  if (wrapMode !== 'wrap' || width <= 0) return lines;
  const out: string[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      out.push(line);
      continue;
    }
    let remaining = line;
    while (remaining.length > width) {
      out.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
    out.push(remaining);
  }
  return out;
}
