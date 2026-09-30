import React from 'react';
import { Box, Text } from 'ink';
import { style as st } from '../style.ts';
import { inkColor } from '../../ui/theme.ts';
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

export const COMMAND_PLACEHOLDER = 'tab to type a command, like add "fix login" or add project web';

/**
 * The third window, at the bottom: a boxed prompt. Focused it has the heavy bright border and a
 * `▌` marker (so it is clear without colour too) and takes plain typing; unfocused it is a light
 * dim box with a hint. Commands are the same ones the shell accepts, with or without `salu`.
 */
export function CommandLine(p: CommandLineProps) {
  const width = Math.max(10, p.columns - 8);
  const color = inkColor(p.focused ? 'accent' : 'chrome');
  const border = color ? { borderColor: color } : { borderDimColor: !p.focused };
  let content: React.ReactNode;
  if (p.busy) content = <Text wrap="truncate-end">{st.accent('▌❯ ') + st.dim('running…')}</Text>;
  else if (!p.focused) content = <Text wrap="truncate-end">{st.dim('❯ ' + COMMAND_PLACEHOLDER)}</Text>;
  else
    content = (
      <Text wrap="truncate-end">
        {st.accent('▌❯ ')}
        <TextField key={p.nonce} value={p.value} onChange={p.onChange} focus width={width} placeholder='add "name"  ·  add project "name"  ·  ? lists everything' />
      </Text>
    );
  return (
    <Box borderStyle={p.focused ? 'bold' : 'round'} {...border} paddingX={1} width={p.columns}>
      {content}
    </Box>
  );
}
