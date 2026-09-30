/**
 * Raw SGR styling for the TUI. Ink's nested <Text color=…> tree costs about 0.08 ms per node
 * (35 rows of 10 nodes = 27 ms per frame); one <Text> holding an ANSI string per row costs
 * 4 ms for the whole frame. So rows, headers and hints are composed as strings here and handed
 * to Ink as a single Text each.
 */
import { detectColorLevel, painter, type ColorLevel } from '../ui/theme.ts';

export interface Style {
  enabled: boolean;
  level: ColorLevel;
  bold: (s: string) => string;
  /** chrome green: borders, hints, secondary text */
  dim: (s: string) => string;
  inverse: (s: string) => string;
  /** error / failed */
  red: (s: string) => string;
  /** success / done */
  green: (s: string) => string;
  /** warning / blocked (amber) */
  yellow: (s: string) => string;
  /** paused (teal) */
  magenta: (s: string) => string;
  /** the one accent colour (matrix green): cursor row, running tickets, wordmark */
  accent: (s: string) => string;
  /** light green body text */
  text: (s: string) => string;
}

/** True unless NO_COLOR is set or the terminal is dumb. */
export function colorsWanted(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NO_COLOR === undefined && env.TERM !== 'dumb';
}

/** `level` defaults to what the terminal supports; `enabled` false forces plain text. */
export function makeStyle(enabled: boolean, level: ColorLevel = detectColorLevel(process.env, true)): Style {
  const lv: ColorLevel = enabled ? (level || 1) : 0;
  const wrap = (open: string, close: string) => (s: string) => (lv && s ? `\u001b[${open}m${s}\u001b[${close}m` : s);
  return {
    enabled: lv > 0,
    level: lv,
    bold: wrap('1', '22'),
    dim: painter('chrome', lv),
    inverse: wrap('7', '27'),
    red: painter('error', lv),
    green: painter('ok', lv),
    yellow: painter('warn', lv),
    magenta: painter('paused', lv),
    accent: painter('accent', lv),
    text: painter('text', lv),
  };
}

/** The style used inside the interactive views. */
export const style: Style = makeStyle(colorsWanted());
