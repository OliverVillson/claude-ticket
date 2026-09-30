import React, { useMemo, useState } from 'react';
import { Text, useInput } from 'ink';
import type { TicketDetail } from '../store.ts';
import type { Run } from '../../db/types.ts';
import { loadOutput, logStamp, outputRows, statusHasOutput } from '../output.ts';
import { ticketLabels, ticketTags, TICKET_STATUSES } from '../../db/types.ts';
import { formatTags } from '../../core/tags.ts';
import { ago, fmtCost, fmtDuration, priorityText } from '../format.ts';
import { style as st } from '../style.ts';
import { PRIORITY_CHOICES, joinTags, labelOf, splitTags, type Choice } from '../tagGroups.ts';
import { applyTagKey, groupRows } from '../tagRows.ts';
import { Frame, confirmText, hintsText, titleText } from './Frame.tsx';
import { ticketDenials } from '../../core/allow.ts';
import { EditList, type EditRow } from './EditList.tsx';

export interface PropsViewProps {
  columns: number;
  detail: TicketDetail;
  projects: string[];
  now: number;
  /** terminal rows available to the view (the output section scrolls inside it) */
  rows: number;
  /** runs of a ticket, newest first (queried when the view opens and when a new run starts) */
  loadRuns: (ticketId: number) => Run[];
  /** save one property through the `salu change` handlers; resolves to an error message or null */
  onSave: (flag: string, value: string) => Promise<string | null>;
  /** allow the denied rules and queue the ticket again; resolves to an error message or null */
  onAllow: () => string | null;
  onClose: () => void;
}

const HINTS: Array<[string, string]> = [
  ['↑↓', 'move'],
  ['→ ⏎', 'change'],
  ['←', 'back'],
];
const PROPS_OUT_HINTS: Array<[string, string]> = [
  ['↑↓', 'move'],
  ['→ ⏎', 'change'],
  ['o', 'output'],
  ['←', 'back'],
];
const OUTPUT_HINTS: Array<[string, string]> = [
  ['↑↓ pgup/dn', 'scroll'],
  ['[ ]', 'other run'],
  ['p', 'properties'],
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
  const runs = useMemo(() => p.loadRuns(t.id), [t.id, run?.id, t.status]);
  const [editing, setEditing] = useState(false);
  // Finished tickets open on their output (that is what you came to see); `o` and `p` switch.
  const [section, setSection] = useState<'props' | 'output'>(() => (statusHasOutput(t.status) && runs.length > 0 ? 'output' : 'props'));
  const [runIdx, setRunIdx] = useState(0);
  const [top, setTop] = useState(0);
  const [asking, setAsking] = useState(false); // the allow-and-queue confirm line
  const [note, setNote] = useState<string | null>(null);
  const [custom, setCustom] = useState(false); // `custom` with empty lists writes no tag: remember the pick
  const denials = statusHasOutput(t.status) ? ticketDenials(t) : [];
  const needs = [...new Set(denials.map((d) => d.rule))];
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
    ...(needs.length ? [{ key: 'needs', label: 'needs', kind: 'readonly' as const, value: `permission: ${needs.join(', ')} (press a to allow)` }] : []),
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

  const width = Math.max(20, p.columns - 4);
  const height = Math.max(3, p.rows - 4);
  const idx = Math.min(runIdx, Math.max(0, runs.length - 1));
  const logPath = runs[idx]?.log_path ?? null;
  const stamp = section === 'output' ? logStamp(logPath) : '';
  const lines = useMemo(() => (section === 'output' ? loadOutput(logPath) : []), [section, logPath, stamp]);
  const outRows = useMemo(
    () => (section === 'output' ? outputRows({ ticket: t, runs: runs, index: idx, lines, width, now: p.now, st }) : []),
    [section, t, runs, idx, lines, width, Math.floor(p.now / 10000)],
  );
  const maxTop = Math.max(0, outRows.length - height);
  const at = Math.min(top, maxTop);

  useInput((input, key) => {
    if (asking) {
      if (input === 'y' || input === 'Y' || key.return) setNote(p.onAllow());
      setAsking(false);
      return;
    }
    if (input === 'a' && !editing && needs.length) {
      setNote(null);
      setAsking(true);
      return;
    }
    if (section === 'props') {
      if (input === 'o' && !editing) {
        setTop(0);
        setSection('output');
      }
      return;
    }
    if (key.upArrow || input === 'k') setTop(Math.max(0, at - 1));
    else if (key.downArrow || input === 'j') setTop(Math.min(maxTop, at + 1));
    else if (key.pageUp || (key.ctrl && input === 'u')) setTop(Math.max(0, at - height));
    else if (key.pageDown || (key.ctrl && input === 'd')) setTop(Math.min(maxTop, at + height));
    else if (input === 'g' || key.home) setTop(0);
    else if (input === 'G' || key.end) setTop(maxTop);
    else if (input === '[') {
      setRunIdx(Math.min(runs.length - 1, idx + 1));
      setTop(0);
    } else if (input === ']') {
      setRunIdx(Math.max(0, idx - 1));
      setTop(0);
    } else if (input === 'p' || key.leftArrow || key.escape) setSection('props');
  });

  const footerLeft = (hints: Array<[string, string]>) => {
    if (asking) return confirmText(`Allow ${needs.join(', ')} for this ticket and queue it again?`);
    if (note) return st.red(note);
    return hintsText(needs.length && !editing ? [['a', 'allow'], ...hints] : hints, p.columns - 2);
  };
  const crumbs = [t.project, t.name.length > 40 ? t.name.slice(0, 39) + '…' : t.name, section === 'output' ? 'output' : 'properties'];
  const scrollInfo = outRows.length > height ? st.dim(`${at + 1}-${Math.min(outRows.length, at + height)}/${outRows.length}  #${t.id}`) : st.dim(`#${t.id}`);
  if (section === 'output') {
    const hints = runs.length > 1 ? OUTPUT_HINTS : OUTPUT_HINTS.filter(([k]) => k !== '[ ]');
    return (
      <Frame columns={p.columns} header={{ left: titleText(crumbs), right: scrollInfo }} footer={{ left: footerLeft(hints) }}>
        {outRows.slice(at, at + height).map((l, i) => (
          <Text key={i} wrap="truncate-end">
            {st.base(l || ' ')}
          </Text>
        ))}
      </Frame>
    );
  }
  const hasRuns = runs.length > 0;
  return (
    <Frame columns={p.columns} header={{ left: titleText(crumbs), right: st.dim(`#${t.id}`) }} footer={{ left: footerLeft(editing ? EDIT_HINTS : hasRuns ? PROPS_OUT_HINTS : HINTS) }}>
      <EditList columns={p.columns} rows={rows} onSet={onSet} onBack={p.onClose} onEditing={setEditing} />
    </Frame>
  );
}
