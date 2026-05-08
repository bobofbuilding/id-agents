export type TextWrapMode = 'truncate-end' | 'wrap';

export const DEFAULT_TEXT_WRAP_MODE: TextWrapMode = 'truncate-end';

export function textWrapMode(wrapEnabled: boolean): TextWrapMode {
  return wrapEnabled ? 'wrap' : DEFAULT_TEXT_WRAP_MODE;
}

export function toggleWrapEnabled(current: boolean): boolean {
  return !current;
}

export function isWrapToggleInput(input: string): boolean {
  return input === 'w';
}
