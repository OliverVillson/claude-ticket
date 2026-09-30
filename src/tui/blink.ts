/**
 * Blinking for the live indicators: the text cursor you type at, the writing cursor at the end of
 * a running worker's log, and the orchestrator dot while workers run. Pure phase maths plus one
 * hook; timers come from the shared Ticker, so nothing ticks unless something is blinking.
 */
import { useEffect, useState } from 'react';
import { GLYPHS } from '../ui/glyphs.ts';
import { Ticker } from './dog/ticker.ts';
import type { Style } from './style.ts';

/** Half a blink period: on this long, then off this long (about 1 Hz, like a terminal cursor). */
export const BLINK_MS = 530;

/**
 * Whether a blinking indicator is lit at `frame` of an animation that advances every `stepMs`.
 * Frame 0 is lit, so an indicator that has just appeared is visible at once.
 */
export function blinkOn(frame: number, stepMs = 200): boolean {
  return Math.floor((Math.max(0, frame) * stepMs) / BLINK_MS) % 2 === 0;
}

/** Shared timer for text cursors: one tick per half period, only while a focused field listens. */
export const blinkTicker = new Ticker(1000 / BLINK_MS);

/**
 * Cursor blink for a focused text field: lit while `active`, blinking on the shared ticker, and
 * back to lit (restarting the period) whenever `resetKey` changes, so the cursor never vanishes
 * while you type. Inactive fields hold no timer.
 */
export function useBlink(active: boolean, resetKey: unknown, ticker: Ticker = blinkTicker): boolean {
  const [tick, setTick] = useState(ticker.tick);
  const [base, setBase] = useState(ticker.tick);
  useEffect(() => {
    setBase(ticker.tick);
    setTick(ticker.tick);
  }, [resetKey, ticker]);
  useEffect(() => {
    if (!active) return;
    return ticker.subscribe(setTick);
  }, [active, ticker]);
  return !active || (tick - base) % 2 === 0;
}

/** The orchestrator dot while workers run: the on glyph, then a dim dot (● · / * -). */
export function pulseDot(on: boolean, st: Style): string {
  return on ? st.accent(GLYPHS.on) : st.dim(GLYPHS.dot);
}

/** The writing cursor after a running worker's newest output: a bright block, or a blank. */
export function writingCursor(on: boolean, st: Style): string {
  return on ? st.accent(GLYPHS.mark) : ' ';
}

/**
 * Put the writing cursor after the last of `lines` (each at most `width` cells). It goes on the
 * last line when there is room, else on a line of its own; `height` rows are kept by dropping
 * the oldest line.
 */
export function withWritingCursor(lines: string[], width: number, height: number, on: boolean, st: Style, displayWidth: (s: string) => number): string[] {
  const cur = writingCursor(on, st);
  const out = lines.slice();
  const last = out[out.length - 1];
  if (last !== undefined && displayWidth(last) + 2 <= width) out[out.length - 1] = last + ' ' + cur;
  else {
    out.push(cur);
    if (out.length > height) out.shift();
  }
  return out;
}
