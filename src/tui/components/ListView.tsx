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
  /** two-pane layout: the project tree drawn to the left of the tickets (each line exactly `width` cells) */
  sidebar?: { width: number; lines: string[] };
  /** false while the tree has the focus: the ticket cursor is not drawn */
  ticketFocus?: boolean;
  /** breadcrumb path of the selected project (defaults to scopeName) */
  crumbs?: string[];
  /** pending project delete, shown in the footer like the ticket delete */
  projectConfirm?: string | null;
  /** hint bar override (the tree pane has its own keys) */
  hints?: Array<[string, string]>;
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
  [':', 'command'],
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
  const crumbs = p.crumbs?.length ? [...p.crumbs] : [p.scopeName ?? 'all projects'];
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
        <Text>{st.accent('/ ')}</Text>
        <TextField value={p.filter} onChange={p.onFilterChange} focus placeholder="name, #label, status:running, p1, @project" width={fieldWidth} />
        <Text>{st.dim(trail)}</Text>
      </Text>
    );
  } else if (p.projectConfirm) {
    footer = { left: confirmText(p.projectConfirm), right: st.dim(position) };
  } else if (p.confirm) {
    const t = p.confirm;
    const text = `delete "${truncate(t.name, 40)}"?${t.status === 'running' ? ' (running: its worker is stopped)' : ''}`;
    footer = { left: confirmText(text), right: st.dim(position) };
  } else if (p.message) {
    footer = { left: messageText(p.message), right: st.dim(position) };
  } else {
    footer = { left: hintsText(p.hints ?? LIST_HINTS, Math.max(10, cols - 2 - displayWidth(position) - 3)), right: st.dim(position) };
  }

  // Ticket-pane lines as strings, so a sidebar can be joined on row by row (one Text per row).
  let right: string[];
  if (p.tickets.length === 0) {
    right = [
      p.total === 0
        ? st.accent('▌') + st.text(' no tickets yet') + st.dim(' · press ') + st.accent(p.sidebar ? ':' : 'a') + st.dim(p.sidebar ? ' then add "name"' : ' to add one')
        : st.yellow(`nothing matches "${truncate(p.filter.trim(), 30)}"`) + st.dim(' · esc clears the filter'),
    ];
  } else {
    right = [];
    for (let i = p.top; i < end; i++) {
      const t = p.tickets[i]!;
      right.push(renderRow(t, { layout: p.layout, now: p.now, style: st, selected: p.ticketFocus !== false && i === p.cursor, spinner: t.status === 'running' ? p.spinner : undefined }));
    }
    if (overflow) {
      const parts: string[] = [];
      if (p.top) parts.push(`↑ ${p.top} more`);
      if (p.tickets.length - end > 0) parts.push(`↓ ${p.tickets.length - end} more`);
      right.push(st.dim('  ' + parts.join(' · ')));
    }
  }
  let lines = right;
  if (p.sidebar) {
    const { width, lines: left } = p.sidebar;
    const n = Math.max(left.length, right.length);
    const blank = ' '.repeat(width);
    lines = [];
    for (let i = 0; i < n; i++) lines.push((left[i] ?? blank) + st.dim(' │ ') + (right[i] ?? ''));
  }
  const body = lines.map((l, i) => (
    <Text key={i} wrap="truncate-end">
      {l || ' '}
    </Text>
  ));

  return (
    <Frame columns={cols} header={{ left: titleText(crumbs), right: headerRight }} footer={footer}>
      {body}
    </Frame>
  );
}

export const listInnerWidth = (columns: number) => Math.max(16, columns - 4);
