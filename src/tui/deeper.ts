import { GLYPHS } from '../ui/glyphs.ts';
import { displayWidth } from './format.ts';
import type { Style } from './style.ts';

/**
 * The arrow at the right end of the selected row when pressing → would go deeper. The last cell
 * of every row is reserved (rows are laid out two cells narrower), so the arrow never shifts a
 * column or pushes text; rows without it end in a blank cell.
 */
export const DEEPER_CELLS = 2; // one gap + the arrow

/** `line` padded to `width` cells with the last cell holding the arrow (or blank). */
export function endCell(line: string, width: number, st: Style, arrow: boolean): string {
  const gap = width - 1 - displayWidth(line);
  const body = gap >= 0 ? line + ' '.repeat(gap) : line;
  return body + (arrow ? st.accent(GLYPHS.deeper) : ' ');
}
