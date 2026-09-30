// Tiny ANSI helpers. No dependency, respects NO_COLOR and non-TTY output.
const enabled = (() => {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  return !!process.stdout.isTTY;
})();

const wrap = (open: number, close: number) => (s: string) =>
  enabled ? `\u001b[${open}m${s}\u001b[${close}m` : s;

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const italic = wrap(3, 23);
export const underline = wrap(4, 24);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const magenta = wrap(35, 39);
export const cyan = wrap(36, 39);
export const gray = wrap(90, 39);
export const colorEnabled = enabled;

/** Strip ANSI escape codes (for width calculations). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}
