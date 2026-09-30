/**
 * Pure frame renderer: pixel sprites in, terminal lines out. Two pixels per cell using the
 * half blocks ▀ ▄ █, painted with the salu palette only (greens). No I/O, no timers.
 */
import { PALETTE, type ColorLevel, type Role } from '../../ui/theme.ts';
import {
  ASCII_MINI_RUN, ASCII_MINI_SLEEP, ASCII_RUN, ASCII_SLEEP, MINI_RUN, MINI_SLEEP, RUN, SLEEP, WIDTH,
} from './sprites.ts';

export type DogSize = 'full' | 'mini';
export type DogMode = 'run' | 'sleep';

const ROLE: Record<string, Role> = { A: 'accent', T: 'text', M: 'ok', D: 'chrome' };
const ESC = '\u001b[';

function fgCode(role: Role, level: ColorLevel): string {
  const s = PALETTE[role];
  return level === 3 ? `38;2;${s.rgb.join(';')}` : level === 2 ? `38;5;${s.c256}` : String(s.c16);
}
function bgCode(role: Role, level: ColorLevel): string {
  const s = PALETTE[role];
  return level === 3 ? `48;2;${s.rgb.join(';')}` : level === 2 ? `48;5;${s.c256}` : String(s.c16 + 10);
}

/** One terminal row from two pixel rows. */
export function cellRow(top: string, bottom: string, level: ColorLevel): string {
  let out = '';
  let cur = ''; // SGR currently open
  const w = Math.max(top.length, bottom.length);
  for (let i = 0; i < w; i++) {
    const t = ROLE[top[i] ?? '.'];
    const b = ROLE[bottom[i] ?? '.'];
    let ch: string;
    let sgr = '';
    if (!t && !b) ch = ' ';
    else if (t && !b) { ch = '▀'; sgr = fgCode(t, level); }
    else if (!t && b) { ch = '▄'; sgr = fgCode(b, level); }
    else if (t === b) { ch = '█'; sgr = fgCode(t, level); }
    else { ch = '▀'; sgr = `${fgCode(t!, level)};${bgCode(b!, level)}`; }
    if (sgr !== cur) {
      if (cur) out += `${ESC}39;49m`;
      if (sgr) out += `${ESC}${sgr}m`;
      cur = sgr;
    }
    out += ch;
  }
  if (cur) out += `${ESC}39;49m`;
  return out;
}

/** Sprite rows to terminal lines. */
export function renderSprite(px: readonly string[], level: ColorLevel): string[] {
  const lines: string[] = [];
  for (let r = 0; r < px.length; r += 2) lines.push(cellRow(px[r]!, px[r + 1] ?? '', level));
  return lines;
}

/** Frame counts per mode and size (the ticker cycles through these). */
export function frameCount(mode: DogMode, size: DogSize = 'full'): number {
  return size === 'mini' ? (mode === 'run' ? MINI_RUN.length : MINI_SLEEP.length) : mode === 'run' ? RUN.length : SLEEP.length;
}

/** Dog width in terminal cells for a size at a colour level (ASCII frames are 14 wide). */
export function dogWidth(size: DogSize = 'full', level: ColorLevel = 3): number {
  if (level === 0) return size === 'mini' ? 7 : 14;
  return size === 'mini' ? 10 : WIDTH;
}

/**
 * Lines for one frame. `tick` is any increasing counter; the frame index wraps. Level 0 (NO_COLOR,
 * dumb terminals) returns plain ASCII with no escapes. Sleeping frames advance 4x slower so
 * the "z" drifts gently rather than flickers.
 */
export function renderDog(tick: number, opts: { mode?: DogMode; size?: DogSize; level: ColorLevel }): string[] {
  const { mode = 'run', size = 'full', level } = opts;
  const t = mode === 'sleep' ? Math.floor(tick / 4) : tick;
  const n = frameCount(mode, size);
  const i = ((t % n) + n) % n;
  if (level === 0) {
    if (size === 'mini') return [(mode === 'run' ? ASCII_MINI_RUN : ASCII_MINI_SLEEP)[i]!];
    return [...(mode === 'run' ? ASCII_RUN : ASCII_SLEEP)[i]!];
  }
  const set = size === 'mini' ? (mode === 'run' ? MINI_RUN : MINI_SLEEP) : mode === 'run' ? RUN : SLEEP;
  return renderSprite(set[i]!, level);
}

/**
 * The dog running along a track `width` cells wide; `progress` (0..1) places it. Each line is
 * padded on the left so the lines stay the same visible width as `width`.
 */
export function renderTrack(tick: number, width: number, progress: number, opts: { size?: DogSize; level: ColorLevel }): string[] {
  const dw = dogWidth(opts.size, opts.level);
  const room = Math.max(0, width - dw);
  const x = Math.round(Math.min(1, Math.max(0, progress)) * room);
  return renderDog(tick, { ...opts, mode: 'run' }).map((l) => ' '.repeat(x) + l);
}

/** Visible width of a rendered line (escapes stripped). */
export const visibleWidth = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '').length;
