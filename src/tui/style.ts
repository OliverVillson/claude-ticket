/**
 * Raw SGR styling for the TUI. Ink's nested <Text color=…> tree costs about 0.08 ms per node
 * (35 rows of 10 nodes = 27 ms per frame); one <Text> holding an ANSI string per row costs
 * 4 ms for the whole frame. So rows, headers and hints are composed as strings here and handed
 * to Ink as a single Text each.
 */
export interface Style {
  enabled: boolean;
  bold: (s: string) => string;
  dim: (s: string) => string;
  inverse: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  magenta: (s: string) => string;
  /** the one accent colour (Claude's orange): cursor row, running tickets, prompt marks */
  accent: (s: string) => string;
}

/** True unless NO_COLOR is set or the terminal is dumb. */
export function colorsWanted(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NO_COLOR === undefined && env.TERM !== 'dumb';
}

export function makeStyle(enabled: boolean, truecolor = /truecolor|24bit/i.test(process.env.COLORTERM ?? '')): Style {
  const wrap = (open: string, close: string) => (s: string) => (enabled && s ? `\u001b[${open}m${s}\u001b[${close}m` : s);
  return {
    enabled,
    bold: wrap('1', '22'),
    dim: wrap('2', '22'),
    inverse: wrap('7', '27'),
    red: wrap('31', '39'),
    green: wrap('32', '39'),
    yellow: wrap('33', '39'),
    magenta: wrap('35', '39'),
    accent: wrap(truecolor ? '38;2;217;119;87' : '38;5;173', '39'),
  };
}

/** The style used inside the interactive views. */
export const style: Style = makeStyle(colorsWanted());
