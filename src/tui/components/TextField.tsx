import React, { useEffect, useState } from 'react';
import { Text, useInput } from 'ink';
import { displayWidth } from '../format.ts';
import { style as st } from '../style.ts';

export interface TextFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** only the focused field consumes keystrokes */
  focus: boolean;
  placeholder?: string;
  /** visible cells; longer text scrolls so the cursor stays in view */
  width?: number;
}

/**
 * A single-line text input in the style of the claude prompt: plain text with a block cursor.
 * Handles the readline keys people expect (arrows, home/end, ctrl-a/e/u/k/w, backspace).
 * Enter, Tab, Escape and up/down are left to the parent so it can move between fields.
 */
export function TextField({ value, onChange, focus, placeholder, width }: TextFieldProps) {
  const chars = Array.from(value);
  const [cursor, setCursor] = useState(chars.length);
  useEffect(() => {
    if (cursor > chars.length) setCursor(chars.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useInput(
    (input, key) => {
      if (key.return || key.tab || key.escape || key.upArrow || key.downArrow) return;
      const at = Math.min(cursor, chars.length);
      if (key.leftArrow) {
        setCursor(Math.max(0, at - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor(Math.min(chars.length, at + 1));
        return;
      }
      if (key.home || (key.ctrl && input === 'a')) {
        setCursor(0);
        return;
      }
      if (key.end || (key.ctrl && input === 'e')) {
        setCursor(chars.length);
        return;
      }
      if (key.backspace || key.delete) {
        if (at === 0) return;
        onChange([...chars.slice(0, at - 1), ...chars.slice(at)].join(''));
        setCursor(at - 1);
        return;
      }
      if (key.ctrl && input === 'u') {
        onChange(chars.slice(at).join(''));
        setCursor(0);
        return;
      }
      if (key.ctrl && input === 'k') {
        onChange(chars.slice(0, at).join(''));
        return;
      }
      if (key.ctrl && input === 'w') {
        let i = at;
        while (i > 0 && chars[i - 1] === ' ') i--;
        while (i > 0 && chars[i - 1] !== ' ') i--;
        onChange([...chars.slice(0, i), ...chars.slice(at)].join(''));
        setCursor(i);
        return;
      }
      if (key.ctrl || key.meta || !input) return;
      // Printable input (may be several chars when pasted). Drop control characters.
      const clean = Array.from(input).filter((c) => c.codePointAt(0)! >= 0x20 && c !== '\u007f');
      if (!clean.length) return;
      onChange([...chars.slice(0, at), ...clean, ...chars.slice(at)].join(''));
      setCursor(at + clean.length);
    },
    { isActive: focus },
  );

  if (!focus) {
    if (!value) return <Text>{st.dim(placeholder ?? '')}</Text>;
    return <Text>{st.text(width ? sliceToWidth(chars, 0, width) : value)}</Text>;
  }

  const at = Math.min(cursor, chars.length);
  // Horizontal scrolling window so the cursor is always visible.
  let start = 0;
  if (width && width > 1) {
    while (displayWidth(chars.slice(start, at).join('')) >= width - 1) start++;
  }
  const before = chars.slice(start, at).join('');
  const cur = at < chars.length ? chars[at]! : ' ';
  let after = chars.slice(at + 1).join('');
  if (width) {
    const room = width - displayWidth(before) - displayWidth(cur);
    after = sliceToWidth(Array.from(after), 0, Math.max(0, room));
  }
  if (!value && placeholder) {
    return (
      <Text>
        {st.inverse(st.accent(placeholder[0] ?? ' ')) + st.dim(placeholder.slice(1))}
      </Text>
    );
  }
  return (
    <Text>
      {st.text(before) + st.inverse(st.accent(cur)) + st.text(after)}
    </Text>
  );
}

function sliceToWidth(chars: string[], start: number, width: number): string {
  let out = '';
  let w = 0;
  for (let i = start; i < chars.length; i++) {
    const cw = displayWidth(chars[i]!);
    if (w + cw > width) break;
    out += chars[i];
    w += cw;
  }
  return out;
}
