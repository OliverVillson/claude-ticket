import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import { Frame, hintsText, titleText } from './Frame.tsx';
import { style as st } from '../style.ts';
import { inkColor } from '../../ui/theme.ts';
import { TextField } from './TextField.tsx';
import { TagEditor } from './TagEditor.tsx';
import { GROUP_LABEL, type TagGroup } from '../tagRows.ts';
import { groupSummary, splitTags } from '../tagGroups.ts';

export interface FormValues {
  name: string;
  query: string;
  tags: string;
  /** "1".."5" or "now"; empty keeps the current priority */
  priority: string;
  /** also queue the ticket after saving (otherwise it stays in the backlog) */
  queue?: boolean;
}

export interface FormViewProps {
  columns: number;
  mode: 'add' | 'edit';
  projectName: string;
  initial: FormValues;
  error: string | null;
  onSubmit: (v: FormValues) => void;
  onCancel: () => void;
  onChange?: () => void;
  /** show the save-only / save-and-queue choice (a new ticket, or one still in the backlog) */
  canQueue?: boolean;
}

const FIELDS: Array<{ key: keyof FormValues; label: string; placeholder: string; width?: number }> = [
  { key: 'name', label: 'name', placeholder: 'short unique name' },
  { key: 'query', label: 'query', placeholder: 'the prompt the worker agent gets' },
  { key: 'tags', label: 'tags', placeholder: 'model=opus effort=high max-turns=30 bug' },
  { key: 'priority', label: 'priority', placeholder: '1 (highest) to 5, or now', width: 12 },
];

export const FORM_HINTS: Array<[string, string]> = [
  ['⏎', 'save'],
  ['tab', 'next field'],
  ['→', 'tag groups'],
  ['esc', 'cancel'],
];

const TAG_HINTS: Array<[string, string]> = [
  ['↑↓', 'move'],
  ['→ ⏎', 'open / change'],
  ['←', 'back'],
];

const TAGS = 2; // index of the tags row in FIELDS
const QUEUE = FIELDS.length; // the optional save-and-queue row comes after the fields

/**
 * Inline add/edit form inside the same frame. Enter saves when name and query are filled,
 * otherwise jumps to the first empty one. Tab, shift-tab and up/down move between fields.
 */
export function FormView(p: FormViewProps) {
  const [values, setValues] = useState<FormValues>(p.initial);
  const [focus, setFocus] = useState(0);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [group, setGroup] = useState<TagGroup | null>(null);
  const rowCount = FIELDS.length + (p.canQueue ? 1 : 0);
  const set = (k: keyof FormValues) => (v: string) => {
    setValues((prev) => ({ ...prev, [k]: v }));
    p.onChange?.();
  };

  useInput(
    (_input, key) => {
    if (p.canQueue && focus === QUEUE && (key.rightArrow || key.leftArrow || _input === ' ')) {
      setValues((prev) => ({ ...prev, queue: !prev.queue }));
      return;
    }
    if (focus === TAGS && key.rightArrow) {
      setTagsOpen(true);
      return;
    }
    if (key.escape) {
      p.onCancel();
      return;
    }
    if (key.tab || key.downArrow) {
      setFocus((f) => (key.shift ? (f + rowCount - 1) % rowCount : (f + 1) % rowCount));
      return;
    }
    if (key.upArrow) {
      setFocus((f) => (f + rowCount - 1) % rowCount);
      return;
    }
    if (key.return) {
      if (!values.name.trim()) return setFocus(0);
      if (!values.query.trim()) return setFocus(1);
      p.onSubmit({ name: values.name.trim(), query: values.query.trim(), tags: values.tags.trim(), priority: values.priority.trim(), queue: !!values.queue });
    }
    },
    { isActive: !tagsOpen },
  );

  const cols = p.columns;
  const labelW = 11;
  const crumbs = [p.projectName, p.mode === 'add' ? 'new ticket' : `edit ${p.initial.name}`];
  const help = 'tags: press → to choose model / effort, tools and other settings';
  const summary = groupSummary(splitTags(values.tags));
  return (
    <Frame columns={cols} header={{ left: titleText(crumbs) }} footer={{ left: hintsText(tagsOpen ? TAG_HINTS : FORM_HINTS, cols - 2) }}>
      {FIELDS.map((f, i) => {
        const label = (
          <Text color={inkColor(i === focus ? 'accent' : 'chrome')}>{(i === focus ? '❯ ' : '  ') + f.label.padEnd(labelW - 2)}</Text>
        );
        if (f.key === 'tags') {
          return (
            <React.Fragment key="tags">
              <Text wrap="truncate-end">
                {label}
                {values.tags ? st.text(values.tags) : st.dim(`${summary.modelEffort} · ${summary.tools}   → to choose`)}
                {tagsOpen && group ? st.dim(`   ${GROUP_LABEL[group]}`) : ''}
              </Text>
              {tagsOpen ? (
                <TagEditor
                  columns={cols}
                  tags={values.tags}
                  onChange={(t) => {
                    set('tags')(t);
                    return null;
                  }}
                  onGroup={setGroup}
                  onClose={() => {
                    setTagsOpen(false);
                    setGroup(null);
                  }}
                />
              ) : null}
            </React.Fragment>
          );
        }
        return (
          <Text key={f.key} wrap="truncate-end">
            {label}
            <TextField value={String(values[f.key] ?? '')} onChange={set(f.key)} focus={i === focus && !tagsOpen} placeholder={f.placeholder} width={Math.max(10, Math.min(f.width ?? 999, cols - 4 - labelW))} />
          </Text>
        );
      })}
      {p.canQueue ? (
        <Text wrap="truncate-end">
          <Text color={inkColor(focus === QUEUE ? 'accent' : 'chrome')}>{(focus === QUEUE ? '❯ ' : '  ') + 'then'.padEnd(labelW - 2)}</Text>
          {values.queue ? st.accent('save and queue') + st.dim('  runs as soon as a worker is free') : st.text('save only') + st.dim('  stays in the backlog until you queue it (u)')}
          {focus === QUEUE ? st.dim('   ← → or space to change') : ''}
        </Text>
      ) : null}
      <Text> </Text>
      {p.error ? (
        <Text color={inkColor('error')} wrap="truncate-end">
          {'✗ ' + p.error}
        </Text>
      ) : (
        <Text wrap="truncate-end">{st.dim(help)}</Text>
      )}
    </Frame>
  );
}
