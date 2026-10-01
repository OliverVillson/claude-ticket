// Mouse reporting for the TUI. Terminals send mouse events as escape sequences on stdin once asked;
// Ink hands them to `useInput` as text (with the leading ESC removed), so a screen that wants the
// mouse asks the terminal with MOUSE_ON, feeds every input string to `parseMouse`, and sends
// MOUSE_OFF when it closes.
//
//   1000  press and release   1003  every movement (hover)   1006  SGR coordinates (no 223-column limit)
export const MOUSE_ON = '\u001b[?1000h\u001b[?1003h\u001b[?1006h';
export const MOUSE_OFF = '\u001b[?1006l\u001b[?1003l\u001b[?1000l';

export interface MouseEvent {
  kind: 'move' | 'press' | 'release' | 'wheelUp' | 'wheelDown';
  /** 1-based terminal column and row, as the terminal reports them */
  x: number;
  y: number;
  /** 0 left, 1 middle, 2 right (press and release only) */
  button: number;
}

// `ESC [ < b ; x ; y M` (press or motion) or `... m` (release); Ink may have dropped the ESC.
const SGR = /^\u001b?\[<(\d+);(\d+);(\d+)([Mm])$/;

/** True when `input` is a mouse report, so key handlers can ignore it. */
export function isMouseInput(input: string): boolean {
  return SGR.test(input);
}

export function parseMouse(input: string): MouseEvent | null {
  const m = SGR.exec(input);
  if (!m) return null;
  const b = Number(m[1]);
  const x = Number(m[2]);
  const y = Number(m[3]);
  const release = m[4] === 'm';
  if (b & 64) return { kind: b & 1 ? 'wheelDown' : 'wheelUp', x, y, button: 0 };
  if (b & 32) return { kind: 'move', x, y, button: b & 3 }; // motion (with or without a button held)
  return { kind: release ? 'release' : 'press', x, y, button: b & 3 };
}
