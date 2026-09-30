import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import type { Choice } from '../tagGroups.ts';
import { truncate } from '../format.ts';
import { style as st } from '../style.ts';
import { inkColor } from '../../ui/theme.ts';
import { TextField } from './TextField.tsx';

/**
 * A column of editable rows, shared by the tag groups in the ticket form and the ticket
 * properties view. Up/down move, Right or Enter change the row (a pick-list, an inline text
 * field, or a deeper menu), Left or Esc go back. Owns the keys while it is mounted.
 */
export interface EditRow {
  key: string;
  label: string;
  /** what the row shows; for a pick row this is the label of the current choice */
  value: string;
  kind: 'pick' | 'text' | 'menu' | 'readonly';
  /** pick: the choices; text: unused */
  choices?: Choice[];
  /** the raw current value (pick: the selected choice value; text: the text to edit) */
  raw?: string;
  placeholder?: string;
}

export interface EditListProps {
  columns: number;
  rows: EditRow[];
  /** returns an error message to keep the editor open, or null/undefined when saved */
  onSet: (key: string, raw: string) => string | null | undefined | Promise<string | null | undefined>;
  onMenu?: (key: string) => void;
  onBack: () => void;
  /** notified when the pick-list / text editor opens or closes, so hints can follow */
  onEditing?: (editing: boolean) => void;
  /** first row to focus */
  start?: number;
}

const LABEL_W = 14;

export function EditList(p: EditListProps) {
  const rows = p.rows;
  const [cursor, setCursor] = useState(Math.min(p.start ?? 0, Math.max(0, rows.length - 1)));
  const [edit, setEdit] = useState<{ kind: 'pick' | 'text'; draft: string; pick: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const at = Math.min(cursor, Math.max(0, rows.length - 1));
  const row = rows[at];

  const setEditing = (e: typeof edit) => {
    setEdit(e);
    p.onEditing?.(!!e);
  };
  const commit = async (raw: string) => {
    if (!row) return;
    const e = await p.onSet(row.key, raw);
    if (e) return setErr(e);
    setErr(null);
    setEditing(null);
  };
  const open = () => {
    if (!row || row.kind === 'readonly') return;
    setErr(null);
    if (row.kind === 'menu') return p.onMenu?.(row.key);
    if (row.kind === 'text') return setEditing({ kind: 'text', draft: row.raw ?? '', pick: 0 });
    const i = Math.max(0, (row.choices ?? []).findIndex((c) => c.value === (row.raw ?? '')));
    setEditing({ kind: 'pick', draft: '', pick: i });
  };

  useInput((_input, key) => {
    if (edit?.kind === 'pick') {
      const ch = row?.choices ?? [];
      if (key.upArrow) setEdit({ ...edit, pick: (edit.pick + ch.length - 1) % ch.length });
      else if (key.downArrow) setEdit({ ...edit, pick: (edit.pick + 1) % ch.length });
      else if (key.return || key.rightArrow) void commit(ch[edit.pick]?.value ?? '');
      else if (key.leftArrow || key.escape) setEditing(null);
      return;
    }
    if (edit?.kind === 'text') {
      if (key.return) void commit(edit.draft);
      else if (key.escape) {
        setErr(null);
        setEditing(null);
      }
      return; // the TextField consumes the rest
    }
    if (key.upArrow) setCursor((c) => (Math.min(c, rows.length - 1) + rows.length - 1) % rows.length);
    else if (key.downArrow) setCursor((c) => (Math.min(c, rows.length - 1) + 1) % rows.length);
    else if (key.rightArrow || key.return) open();
    else if (key.leftArrow || key.escape) p.onBack();
  });

  const inner = Math.max(16, p.columns - 4);
  if (edit?.kind === 'pick' && row) {
    const ch = row.choices ?? [];
    return (
      <>
        <Text wrap="truncate-end">{st.accent(row.label) + st.dim('   ↑↓ choose · ⏎ set · ← back')}</Text>
        {ch.map((c, i) => (
          <Text key={c.value + i} wrap="truncate-end" color={inkColor(i === edit.pick ? 'accent' : 'text')}>
            {(i === edit.pick ? '❯ ' : '  ') + c.label + (c.value === (row.raw ?? '') ? ' ✓' : '') + (c.hint ? '  ' + c.hint : '')}
          </Text>
        ))}
        {err ? <Text color={inkColor('error')}>{'✗ ' + err}</Text> : null}
      </>
    );
  }
  return (
    <>
      {rows.map((r, i) => {
        const on = i === at;
        const label = (on ? '❯ ' : '  ') + r.label.padEnd(LABEL_W - 2);
        if (on && edit?.kind === 'text') {
          return (
            <Text key={r.key} wrap="truncate-end">
              <Text color={inkColor('accent')}>{label}</Text>
              <TextField value={edit.draft} onChange={(v) => setEdit({ ...edit, draft: v })} focus placeholder={r.placeholder} width={Math.max(10, inner - LABEL_W)} />
            </Text>
          );
        }
        const val = truncate(r.value, Math.max(4, inner - LABEL_W - (r.kind === 'menu' || r.kind === 'pick' ? 2 : 0)));
        const tail = r.kind === 'menu' ? ' →' : '';
        return (
          <Text key={r.key} wrap="truncate-end" color={inkColor(on ? 'accent' : r.kind === 'readonly' ? 'chrome' : 'text')}>
            {label + val + tail}
          </Text>
        );
      })}
      {err ? <Text color={inkColor('error')}>{'✗ ' + err}</Text> : null}
    </>
  );
}

