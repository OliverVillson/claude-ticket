import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import { Frame, hintsText, titleText } from './Frame.tsx';
import { TextField } from './TextField.tsx';

export interface FormValues {
  name: string;
  query: string;
  tags: string;
  /** "1".."5" or "now"; empty keeps the current priority */
  priority: string;
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
  ['esc', 'cancel'],
];

/**
 * Inline add/edit form inside the same frame. Enter saves when name and query are filled,
 * otherwise jumps to the first empty one. Tab, shift-tab and up/down move between fields.
 */
export function FormView(p: FormViewProps) {
  const [values, setValues] = useState<FormValues>(p.initial);
  const [focus, setFocus] = useState(0);
  const set = (k: keyof FormValues) => (v: string) => {
    setValues((prev) => ({ ...prev, [k]: v }));
    p.onChange?.();
  };

  useInput((_input, key) => {
    if (key.escape) {
      p.onCancel();
      return;
    }
    if (key.tab || key.downArrow) {
      setFocus((f) => (key.shift ? (f + FIELDS.length - 1) % FIELDS.length : (f + 1) % FIELDS.length));
      return;
    }
    if (key.upArrow) {
      setFocus((f) => (f + FIELDS.length - 1) % FIELDS.length);
      return;
    }
    if (key.return) {
      if (!values.name.trim()) return setFocus(0);
      if (!values.query.trim()) return setFocus(1);
      p.onSubmit({ name: values.name.trim(), query: values.query.trim(), tags: values.tags.trim(), priority: values.priority.trim() });
    }
  });

  const cols = p.columns;
  const labelW = 11;
  const crumbs = [p.projectName, p.mode === 'add' ? 'new ticket' : `edit ${p.initial.name}`];
  const help = 'tags: model=opus|sonnet|haiku  effort=low|medium|high|xhigh|max  max-turns=N  permission=acceptEdits|bypass  project=name  bare words become labels';
  return (
    <Frame columns={cols} header={{ left: titleText(crumbs) }} footer={{ left: hintsText(FORM_HINTS, cols - 2) }}>
      {FIELDS.map((f, i) => (
        <Text key={f.key} wrap="truncate-end">
          <Text color={i === focus ? '#D97757' : undefined} dimColor={i !== focus}>
            {(i === focus ? '❯ ' : '  ') + f.label.padEnd(labelW - 2)}
          </Text>
          <TextField value={values[f.key]} onChange={set(f.key)} focus={i === focus} placeholder={f.placeholder} width={Math.max(10, Math.min(f.width ?? 999, cols - 4 - labelW))} />
        </Text>
      ))}
      <Text> </Text>
      {p.error ? (
        <Text color="red" wrap="truncate-end">
          {'✗ ' + p.error}
        </Text>
      ) : (
        <Text dimColor wrap="truncate-end">
          {help}
        </Text>
      )}
    </Frame>
  );
}
