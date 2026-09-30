import React, { useState } from 'react';
import { Text } from 'ink';
import type { TicketDetail } from '../store.ts';
import { ticketLabels, ticketTags, TICKET_STATUSES } from '../../db/types.ts';
import { formatTags } from '../../core/tags.ts';
import { ago, fmtCost, fmtDuration, priorityText } from '../format.ts';
import { style as st } from '../style.ts';
import { PRIORITY_CHOICES, joinTags, labelOf, splitTags, type Choice } from '../tagGroups.ts';
import { applyTagKey, groupRows } from '../tagRows.ts';
import { Frame, hintsText, titleText } from './Frame.tsx';
import { EditList, type EditRow } from './EditList.tsx';

export interface PropsViewProps {
  columns: number;
  detail: TicketDetail;
  projects: string[];
  now: number;
  /** save one property through the `salu change` handlers; resolves to an error message or null */
  onSave: (flag: string, value: string) => Promise<string | null>;
  onClose: () => void;
}

const HINTS: Array<[string, string]> = [
  ['↑↓', 'move'],
  ['→ ⏎', 'change'],
  ['←', 'back'],
];
const EDIT_HINTS: Array<[string, string]> = [
  ['↑↓', 'choose'],
  ['⏎', 'set'],
  ['esc ←', 'cancel'],
];

const TAG_KEYS = new Set(['model', 'effort', 'toolset', 'allow', 'deny', 'permission', 'maxTurns', 'other']);

/** Every property of one ticket, changeable in place. Opened with → on a ticket. */
export function PropsView(p: PropsViewProps) {
  const { ticket: t, run } = p.detail;
  const [editing, setEditing] = useState(false);
  const [custom, setCustom] = useState(false); // `custom` with empty lists writes no tag: remember the pick
  const parts = splitTags(formatTags(ticketTags(t), ticketLabels(t)));
  if (custom && parts.toolset === '') parts.toolset = 'custom';

  const proj: Choice[] = p.projects.map((n) => ({ value: n, label: n }));
  const statuses: Choice[] = TICKET_STATUSES.map((s) => ({ value: s, label: s }));
  const rows: EditRow[] = [
    { key: 'name', label: 'name', kind: 'text', raw: t.name, value: t.name },
    { key: 'query', label: 'query', kind: 'text', raw: t.query, value: t.query.replace(/\s+/g, ' ') },
    { key: 'project', label: 'project', kind: 'pick', choices: proj, raw: t.project, value: t.project },
    { key: 'status', label: 'status', kind: 'pick', choices: statuses, raw: t.status, value: t.status },
    ...groupRows('me', parts),
    ...groupRows('tools', parts),
    { key: 'priority', label: 'priority', kind: 'pick', choices: PRIORITY_CHOICES, raw: String(t.priority), value: labelOf(PRIORITY_CHOICES, String(t.priority)) === String(t.priority) ? priorityText(t.priority) : labelOf(PRIORITY_CHOICES, String(t.priority)) },
    ...groupRows('other', parts),
    { key: 'created', label: 'created', kind: 'readonly', value: ago(t.created_at, p.now) },
    { key: 'updated', label: 'updated', kind: 'readonly', value: ago(t.updated_at, p.now) },
    {
      key: 'run',
      label: 'last run',
      kind: 'readonly',
      value: run
        ? [run.ended_at ? `ended ${ago(run.ended_at, p.now)}` : `started ${ago(run.started_at, p.now)}`, run.outcome, run.ended_at ? fmtDuration(run.ended_at - run.started_at) : '', run.turns != null ? `${run.turns} turns` : '', run.cost_usd ? fmtCost(run.cost_usd) : '']
            .filter(Boolean)
            .join(' · ')
        : 'never run',
    },
  ];

  const onSet = async (key: string, raw: string): Promise<string | null> => {
    if (TAG_KEYS.has(key)) {
      if (key === 'toolset') setCustom(raw === 'custom');
      const r = applyTagKey(parts, key, raw);
      if (r.error) return r.error;
      return p.onSave('tags', joinTags(r.parts));
    }
    if (key === 'name' || key === 'query') {
      if (!raw.trim()) return `${key} cannot be empty`;
      return p.onSave(key, raw.trim());
    }
    if (key === 'project') return p.onSave('move-to', raw);
    return p.onSave(key, raw);
  };

  const crumbs = [t.project, t.name.length > 40 ? t.name.slice(0, 39) + '…' : t.name, 'properties'];
  return (
    <Frame columns={p.columns} header={{ left: titleText(crumbs), right: st.dim(`#${t.id}`) }} footer={{ left: hintsText(editing ? EDIT_HINTS : HINTS, p.columns - 2) }}>
      <EditList columns={p.columns} rows={rows} onSet={onSet} onBack={p.onClose} onEditing={setEditing} />
    </Frame>
  );
}
