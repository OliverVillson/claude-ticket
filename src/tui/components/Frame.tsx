import React from 'react';
import { Box, Text } from 'ink';
import { displayWidth, truncate } from '../format.ts';
import { style as st } from '../style.ts';
import { paint } from '../theme.ts';
import { MARK, WORDMARK, hex } from '../../ui/theme.ts';

/**
 * The frame every screen shares: a one-line header above a rounded, dim border and a one-line
 * hint bar below it, like the claude prompt box. The box never takes over the screen, so
 * scrollback stays intact. Header and footer are ANSI strings (see style.ts): widths come from
 * displayWidth, which ignores escapes, so callers never count cells by hand.
 */
export interface FrameProps {
  columns: number;
  header: { left: string; right?: string };
  /** a string pair, or a React node when the footer needs a live input (the filter prompt) */
  footer: { left: string; right?: string } | React.ReactNode;
  children: React.ReactNode;
}

/** " left      right": one leading space, right side pushed to the far edge, cut to fit. */
export function joinLine(left: string, right: string | undefined, columns: number): string {
  const lw = displayWidth(left);
  if (!right) return ' ' + left;
  const rw = displayWidth(right);
  const gap = columns - 1 - lw - rw;
  if (gap >= 2) return ' ' + left + ' '.repeat(gap) + right;
  return ' ' + left; // no room: the left side wins
}

function isPair(x: unknown): x is { left: string; right?: string } {
  return !!x && typeof x === 'object' && !React.isValidElement(x) && typeof (x as any).left === 'string';
}

export function Frame(p: FrameProps) {
  const cols = Math.max(20, p.columns);
  return (
    <Box flexDirection="column" width={cols}>
      <Text wrap="truncate-end">{joinLine(p.header.left, p.header.right, cols)}</Text>
      <Box borderStyle="round" {...(st.enabled ? { borderColor: st.level >= 2 ? hex('chrome') : 'green' } : { borderDimColor: true })} flexDirection="column" paddingX={1} width={cols}>
        {p.children}
      </Box>
      {isPair(p.footer) ? <Text wrap="truncate-end">{joinLine(p.footer.left, p.footer.right, cols)}</Text> : p.footer}
    </Box>
  );
}

/** "▌salu › project › …": the wordmark in bright green, the last crumb accented. */
export function titleText(crumbs: string[]): string {
  let out = st.accent(MARK) + st.bold(st.accent(WORDMARK));
  crumbs.forEach((c, i) => {
    out += st.dim(' › ') + (i === crumbs.length - 1 ? st.accent(c) : c);
  });
  return out;
}

export function titleWidth(crumbs: string[]): number {
  return displayWidth(MARK + WORDMARK) + crumbs.reduce((a, c) => a + 3 + displayWidth(c), 0);
}

/** "key action · key action" hints; keys are brighter than actions. Drops items that do not fit. */
export function hintsText(items: Array<[string, string]>, width: number): string {
  let out = '';
  let w = 0;
  for (let i = 0; i < items.length; i++) {
    const [k, a] = items[i]!;
    const segW = displayWidth(`${k} ${a}`) + (i ? 3 : 0);
    if (w + segW > width) break;
    w += segW;
    out += (i ? st.dim(' · ') : '') + k + st.dim(' ' + a);
  }
  return out;
}

/** Yellow question with y/n hints, used by the delete confirm. */
export function confirmText(text: string): string {
  return paint(st, 'yellow', text) + '  y' + st.dim(' confirm · ') + 'n' + st.dim(' cancel');
}

export { truncate };
