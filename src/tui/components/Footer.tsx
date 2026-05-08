import React from 'react';
import { Box, Text } from 'ink';

export type FooterView =
  | 'agents'
  | 'agent-detail'
  | 'news'
  | 'news-detail'
  | 'tasks'
  | 'task-detail'
  | 'calendar'
  | 'heartbeats'
  | 'heartbeat-detail'
  | 'library-agents'
  | 'library-agent-detail'
  | 'library-skills'
  | 'library-skill-detail';

interface FooterProps {
  view: FooterView;
  wrapEnabled: boolean;
}

// Footer is a one-liner. Press `?` to open the full help modal which
// lists every keybinding. Drill-downs keep a `← back` hint since that
// is the most-used affordance from those views; everything else is in
// the modal.
const HAS_BACK: Record<FooterView, boolean> = {
  agents: false,
  'agent-detail': true,
  tasks: true,
  calendar: false,
  heartbeats: false,
  'task-detail': true,
  'heartbeat-detail': true,
  news: true,
  'news-detail': true,
  'library-agents': true,
  'library-agent-detail': true,
  'library-skills': true,
  'library-skill-detail': true,
};

function hintFor(view: FooterView, wrapEnabled: boolean): string {
  const back = HAS_BACK[view] ? ' · ← back' : '';
  const wrap = wrapEnabled ? 'wrap on' : 'wrap off';
  return `↑↓ nav${back} · w ${wrap} · : cmd · ? help · q quit`;
}

export function Footer({ view, wrapEnabled }: FooterProps): React.ReactElement {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text dimColor>{hintFor(view, wrapEnabled)}</Text>
      <Text dimColor>ID Agents Dashboard</Text>
    </Box>
  );
}
