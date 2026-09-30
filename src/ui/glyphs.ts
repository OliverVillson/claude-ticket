/**
 * Every symbol salu prints, in one table, so the TUI and the plain CLI agree and each glyph is
 * chosen once. The unicode set only uses characters that are (a) in Menlo / SF Mono / DejaVu
 * Sans Mono (Menlo's base) or drawn by the terminal itself, (b) not emoji, so no terminal swaps
 * in a colour emoji (⏺ ▶ ✳ ✔ ⏸ are avoided for that reason), and (c) single width. Terminals
 * that cannot show unicode (a non-UTF-8 locale, or SALU_ASCII=1) get the ASCII set.
 */
export interface Glyphs {
  /** ticket statuses */
  todo: string;
  running: string;
  paused: string;
  blocked: string;
  failed: string;
  done: string;
  interrupted: string;
  /** orchestrator on / off */
  on: string;
  off: string;
  /** a worker started or dispatch resumed */
  start: string;
  /** assistant text and tool calls in a transcript, and the result under a tool call */
  say: string;
  toolResult: string;
  /** selected row */
  cursor: string;
  /** block cursor in front of the wordmark */
  mark: string;
  /** separator in status lines and breadcrumbs */
  dot: string;
  crumb: string;
  ellipsis: string;
  /** the "thinking" spinner for running tickets */
  spinner: string[];
}

export const UNICODE_GLYPHS: Glyphs = {
  todo: '○',
  running: '●',
  paused: '‖',
  blocked: '?',
  failed: '✗',
  done: '✓',
  interrupted: '■',
  on: '●',
  off: '○',
  start: '▸',
  say: '●',
  toolResult: '└',
  cursor: '❯',
  mark: '▌',
  dot: '·',
  crumb: '›',
  ellipsis: '…',
  spinner: ['·', '✢', '✶', '✻', '✽', '✻', '✶', '✢'],
};

export const ASCII_GLYPHS: Glyphs = {
  todo: 'o',
  running: '*',
  paused: '=',
  blocked: '?',
  failed: 'x',
  done: '+',
  interrupted: '#',
  on: '*',
  off: 'o',
  start: '>',
  say: '*',
  toolResult: '`',
  cursor: '>',
  mark: '|',
  dot: '-',
  crumb: '>',
  ellipsis: '...',
  spinner: ['-', '\\', '|', '/'],
};

/**
 * Whether the terminal can show the unicode set: not when the locale names a charset other than
 * UTF-8, or is plain C / POSIX. No locale at all (common in GUI terminals on macOS) counts as
 * unicode. SALU_ASCII=1 forces ASCII, SALU_ASCII=0
 * forces unicode.
 */
export function supportsUnicode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SALU_ASCII === '0') return true;
  if (env.SALU_ASCII) return false;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  if (/\./.test(locale)) return /utf-?8/i.test(locale);
  return locale !== 'C' && locale !== 'POSIX';
}

export const glyphsFor = (env: NodeJS.ProcessEnv = process.env): Glyphs => (supportsUnicode(env) ? UNICODE_GLYPHS : ASCII_GLYPHS);

/** The set for this process. */
export const GLYPHS: Glyphs = glyphsFor();
