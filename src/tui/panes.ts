import { displayWidth } from './format.ts';
import type { Style } from './style.ts';

/**
 * One pane of the two-pane layout drawn as a box of plain strings. The active pane is
 * unmistakable even without colour: heavy borders and a `▌` marker in front of its title,
 * against light rounded borders for the inactive one. Colour adds bright green versus dim green.
 */
export interface PaneBox {
  title: string;
  /** content lines, each already padded to `inner` cells */
  lines: string[];
  /** content width between the side borders and their one-space padding */
  inner: number;
  active: boolean;
  /** number of content rows to draw (short panes are padded with blanks) */
  height: number;
  /** title colour for a quiet box (the activity area names its ticket in light green) */
  tone?: 'text';
}

export const paneWidth = (inner: number) => inner + 4;

export function drawPane(b: PaneBox, st: Style): string[] {
  const total = paneWidth(b.inner);
  const paint = (s: string) => (b.active ? st.accent(s) : st.dim(s));
  const [tl, tr, bl, br, h, v] = b.active ? ['┏', '┓', '┗', '┛', '━', '┃'] : ['╭', '╮', '╰', '╯', '─', '│'];
  const label = b.active ? ` ▌${b.title} ` : ` ${b.title} `;
  const fill = Math.max(0, total - 2 - 1 - displayWidth(label));
  const title = b.active ? st.bold(st.accent(label)) : b.tone === 'text' ? st.text(label) : st.dim(label);
  const out = [paint(tl + h) + title + paint(h.repeat(fill) + tr)];
  const blank = ' '.repeat(b.inner);
  for (let i = 0; i < b.height; i++) out.push(paint(v) + ' ' + (b.lines[i] ?? blank) + ' ' + paint(v));
  out.push(paint(bl + h.repeat(total - 2) + br));
  return out;
}
