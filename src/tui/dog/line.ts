/**
 * Stateless single-line API for hosts that already own an animation tick (the TUI header):
 * pass any increasing `frame`, get one ANSI string. No timers here.
 */
import type { ColorLevel } from '../../ui/theme.ts';
import { detectColorLevel } from '../../ui/theme.ts';
import { renderDog, renderSprite } from './render.ts';
import { ASCII_LINE_RUN, LINE_RUN } from './sprites.ts';

/** Cells occupied by `dogFrame` (colour). ASCII output is 6 wide; pad to this if you need a fixed slot. */
export const DOG_WIDTH = 10;

const defaultLevel = (): ColorLevel => detectColorLevel(process.env, true);

/** ONE line, half-block pixels in greens (plain ASCII at level 0). */
export function dogFrame(frame: number, opts: { level?: ColorLevel } = {}): string {
  const level = opts.level ?? defaultLevel();
  const n = LINE_RUN.length;
  const i = ((frame % n) + n) % n;
  return level === 0 ? ASCII_LINE_RUN[i]! : renderSprite(LINE_RUN[i]!, level)[0]!;
}

/** Multi-line (10 rows, 36 cells) run variant. */
export function dogLines(frame: number, opts: { level?: ColorLevel } = {}): string[] {
  return renderDog(frame, { level: opts.level ?? defaultLevel() });
}
