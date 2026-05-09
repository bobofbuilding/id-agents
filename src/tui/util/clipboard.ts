// OSC 52 clipboard write. Works in modern terminals (iTerm2, kitty, Apple
// Terminal, Alacritty, WezTerm) and in tmux when allow-passthrough is on or
// the user has `set -g set-clipboard on`. No external process is spawned, so
// this works the same locally and over SSH.
//
// Format: ESC ] 52 ; c ; <base64-utf8-text> BEL
//   - "c" selects the system clipboard buffer.
//   - The body is base64 of the UTF-8 bytes of the text.

import type { Writable } from 'node:stream';

export interface ClipboardSink {
  write: (chunk: string) => unknown;
}

export function copyToClipboard(text: string, sink?: ClipboardSink | Writable | null): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  const out = sink ?? (process.stdout as unknown as Writable);
  if (!out || typeof (out as ClipboardSink).write !== 'function') return false;
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  (out as ClipboardSink).write(`]52;c;${encoded}`);
  return true;
}
