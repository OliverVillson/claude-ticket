import React from 'react';
import { Text } from 'ink';
import type { TicketStatus, TicketView } from '../../db/types.ts';
import type { OrchestratorStatus } from '../../orchestrator/status.ts';
import { displayWidth, truncate } from '../format.ts';
import type { RowLayout } from '../layout.ts';
import { messageText, type Message } from '../messages.ts';
import { renderRow } from '../rows.ts';
import { style as st } from '../style.ts';
import { STATUS_ORDER } from '../theme.ts';
import { Frame, confirmText, hintsText, titleText, titleWidth } from './Frame.tsx';
import { statusBadge, statusText } from './Status.tsx';
import { TextField } from './TextField.tsx';

export type { Message } from '../messages.ts';

export interface ListViewProps {
  columns: number;
  /** ticket rows that fit inside the frame (the "N more" line is taken from these) */
  rows: number;
  tickets: TicketView[];
  /** tickets in scope before filtering */
  total: number;
  cursor: number;
  top: number;
  layout: RowLayout;
  scopeName: string | null;
  statuses?: TicketStatus[];
  counts: Record<TicketStatus, number>;
  status: OrchestratorStatus;
  filter: string;
  filterEditing: boolean;
  onFilterChange: (v: string) => void;
  confirm: TicketView | null;
  message: Message | null;
  now: number;
  spinner?: number;
}

export const LIST_HINTS: Array<[string, string]> = [
  ['↑↓', 'move'],
  ['⏎', 'open'],
  ['a', 'add'],
  ['e', 'edit'],
  ['d', 'delete'],
  ['r', 'run now'],
  ['p', 'pause'],
  ['/', 'filter'],
  ['tab', 'project'],
  ['?', 'help'],
  ['q', 'quit'],
];

export function countsText(counts: Record<TicketStatus, number>): string {
  const parts: string[] = [];
  for (const s of STATUS_ORDER) if (counts[s]) parts.push(`${counts[s]} ${s}`);
  return parts.join(' · ');
}

export function ListView(p: ListViewProps) {
  const cols = p.columns;
  const overflow = p.tickets.length > p.rows;
  const rows = overflow ? Math.max(1, p.rows - 1) : p.rows;
  const end = Math.min(p.tickets.length, p.top + rows);

  // Header: crumbs on the left; counts and the orchestrator state on the right.
  const crumbs = [p.scopeName ?? 'all projects'];
  if (p.statuses?.length) crumbs.push(p.statuses.join(','));
  if (!p.filterEditing && p.filter.trim()) crumbs.push(`/${truncate(p.filter.trim(), 24)}`);
  const counts = p.filter.trim() ? `${p.tickets.length} of ${p.total} match` : countsText(p.counts);
  const badgeW = displayWidth(statusText(p.status, p.now));
  const countsShown = truncate(counts, Math.max(0, cols - 1 - titleWidth(crumbs) - badgeW - 9));
  const headerRight = (countsShown ? st.dim(countsShown + '  ·  ') : '') + statusBadge(p.status, p.now);

  // Footer: filter prompt, delete confirm, message or hints; position on the right.
  const position = p.tickets.length ? `${p.cursor + 1}/${p.tickets.length}` : '';
  let footer: React.ComponentProps<typeof Frame>['footer'];
  if (p.filterEditing) {
    const trail = ` · ${p.tickets.length} match · esc clear · ⏎ done`;
    const fieldWidth = Math.max(8, Math.min(48, cols - 4 - displayWidth(trail)));
    footer = (
      <Text wrap="truncate-end">
        {' '}
        <Text color="#D97757">{'/ '}</Text>
        <TextField value={p.filter} onChange={p.onFilterChange} focus placeholder="name, #label, status:running, p1, @project" width={fieldWidth} />
        <Text dimColor>{trail}</Text>
      </Text>
    );
  } else if (p.confirm) {
    const t = p.confirm;
    const text = `delete "${truncate(t.name, 40)}"?${t.status === 'running' ? ' (running: its worker is stopped)' : ''}`;
    footer = { left: confirmText(text), right: st.dim(position) };
  } else if (p.message) {
    footer = { left: messageText(p.message), right: st.dim(position) };
  } else {
    footer = { left: hintsText(LIST_HINTS, Math.max(10, cols - 2 - displayWidth(position) - 3)), right: st.dim(position) };
  }

  let body: React.ReactNode;
  if (p.tickets.length === 0) {
    body = (
      <Text dimColor>
        {p.total === 0 ? 'no tickets yet · press a to add one' : `nothing matches "${truncate(p.filter.trim(), 30)}" · esc clears the filter`}
      </Text>
    );
  } else {
    const lines: React.ReactNode[] = [];
    for (let i = p.top; i < end; i++) {
      const t = p.tickets[i]!;
      lines.push(
        <Text key={t.id} wrap="truncate-end">
          {renderRow(t, { layout: p.layout, now: p.now, style: st, selected: i === p.cursor, spinner: t.status === 'running' ? p.spinner : undefined })}
        </Text>,
      );
    }
    if (overflow) {
      const parts: string[] = [];
      if (p.top) parts.push(`↑ ${p.top} more`);
      if (p.tickets.length - end > 0) parts.push(`↓ ${p.tickets.length - end} more`);
      lines.push(
        <Text key="more" dimColor>
          {'  ' + parts.join(' · ')}
        </Text>,
      );
    }
    body = lines;
  }

  return (
    <Frame columns={cols} header={{ left: titleText(crumbs), right: headerRight }} footer={footer}>
      {body}
    </Frame>
  );
}

export const listInnerWidth = (columns: number) => Math.max(16, columns - 4);
