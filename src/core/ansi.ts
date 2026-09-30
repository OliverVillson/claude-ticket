// Tiny ANSI helpers. No dependency, respects NO_COLOR and non-TTY output. Colours come from the
// shared salu palette (ui/theme.ts): matrix green, with 256/16-colour fallbacks.
import { detectColorLevel, painter } from '../ui/theme.ts';

const level = detectColorLevel();
const enabled = level > 0;

const wrap = (open: number, close: number) => (s: string) =>
  enabled ? `\u001b[${open}m${s}\u001b[${close}m` : s;

export const bold = wrap(1, 22);
export const dim = painter('chrome', level);
export const italic = wrap(3, 23);
export const underline = wrap(4, 24);
export const red = painter('error', level);
export const green = painter('ok', level);
export const yellow = painter('warn', level);
export const blue = wrap(34, 39);
export const magenta = painter('paused', level);
/** the salu "focus" green: headings, running, prompts */
export const cyan = painter('accent', level);
export const gray = painter('chrome', level);
export const colorEnabled = enabled;

/** Strip ANSI escape codes (for width calculations). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * Text from a worker or a remote message made safe to print: whole escape sequences (OSC such as
 * clipboard writes, CSI, other ESC pairs) are removed first, then any control character is dropped.
 * Tabs and newlines stay.
 */
export function stripControl(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b[PX^_][^\u001b]*(?:\u001b\\)?/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b[ -~]?/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}
