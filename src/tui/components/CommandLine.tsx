import React from 'react';
import { Text } from 'ink';
import { style as st } from '../style.ts';
import { TextField } from './TextField.tsx';

export interface CommandLineProps {
  columns: number;
  focused: boolean;
  value: string;
  onChange: (v: string) => void;
  busy: boolean;
  /** bumps when the app rewrites the value (history, completion) so the cursor jumps to the end */
  nonce: number;
}

export const COMMAND_PLACEHOLDER = 'type : for a command, like add "fix login" or add project web';

/**
 * The prompt under the hint bar. Unfocused it is one dim line; focused it is a text field,
 * like the claude prompt. Commands are the same ones the shell accepts, with or without `salu`.
 */
export function CommandLine(p: CommandLineProps) {
  const width = Math.max(10, p.columns - 4);
  if (p.busy) return <Text wrap="truncate-end">{' ' + st.accent('❯ ') + st.dim('running…')}</Text>;
  if (!p.focused) return <Text wrap="truncate-end">{' ' + st.dim('❯ ' + COMMAND_PLACEHOLDER)}</Text>;
  return (
    <Text wrap="truncate-end">
      {' ' + st.accent('❯ ')}
      <TextField key={p.nonce} value={p.value} onChange={p.onChange} focus width={width} placeholder='add "name"  ·  add project "name"  ·  ? lists everything' />
    </Text>
  );
}
