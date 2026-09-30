import type { OrchestratorStatus, PauseInfo } from '../../orchestrator/status.ts';
import { fmtDuration } from '../format.ts';
import { style as st } from '../style.ts';
import { paint } from '../theme.ts';
import { GLYPHS } from '../../ui/glyphs.ts';
import { pulseDot } from '../blink.ts';

/** "‖ paused · session limit · resumes in 42m". */
export function pauseText(p: PauseInfo, now: number): string {
  const bits: string[] = [`${GLYPHS.paused} paused`];
  if (p.manual) bits.push('manual');
  else if (p.kind) bits.push(`${p.kind} limit${p.models.length ? ` (${p.models.join(',')})` : ''}`);
  if (p.until != null) {
    const left = p.until - now;
    bits.push(left > 0 ? `resumes in ${fmtDuration(left)}` : 'checking the window');
    if (p.kind === 'weekly' && left > 36 * 3600_000) bits.push('weekly: can be days');
  }
  return bits.join(' · ');
}

/** "● orchestrator on · 2 workers" / "‖ paused · …" / "○ orchestrator off" (plain text). */
export function statusText(s: OrchestratorStatus, now: number): string {
  if (s.paused) return pauseText(s.paused, now);
  if (s.alive) return `${GLYPHS.on} orchestrator on${s.workers.length ? ` · ${s.workers.length} worker${s.workers.length === 1 ? '' : 's'}` : ''}`;
  return `${GLYPHS.off} orchestrator off`;
}

/**
 * The same text, coloured: magenta when paused, accent when on, dim when off. `lit` false (the
 * dark half of a blink, while workers run) swaps the on dot for a dim one; the width is unchanged.
 */
export function statusBadge(s: OrchestratorStatus, now: number, lit = true): string {
  const text = statusText(s, now);
  if (s.paused) return paint(st, 'magenta', text);
  if (s.alive && !lit) return pulseDot(false, st) + paint(st, 'accent', text.slice(GLYPHS.on.length));
  if (s.alive) return paint(st, 'accent', text);
  return st.dim(text);
}
