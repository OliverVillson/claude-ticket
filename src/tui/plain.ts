import { colorEnabled } from '../core/ansi.ts';
import { byCell } from '../team/view.ts';
import { computeLayout } from './layout.ts';
import { renderHeader, renderRow } from './rows.ts';
import { makeStyle, type Style } from './style.ts';
import type { Snapshot } from './store.ts';

/**
 * `salu list --plain`: the same columns as the interactive view, one line per ticket, no
 * cursor, no polling. Colour follows core/ansi (off when piped or NO_COLOR). Never imports
 * Ink or React.
 */
export interface PlainOptions {
  width?: number;
  showProject?: boolean;
  now?: number;
  header?: boolean;
  style?: Style;
}

export function renderPlain(snapshot: Snapshot, opts: PlainOptions = {}): string {
  const width = opts.width ?? (process.stdout.columns || 100);
  const style = opts.style ?? makeStyle(colorEnabled);
  const layout = computeLayout(width - 2, { showProject: opts.showProject ?? true, showBy: Object.keys(snapshot.teams ?? {}).length > 0 });
  const now = opts.now ?? Date.now();
  const lines: string[] = [];
  if (opts.header !== false) lines.push(renderHeader({ layout, style, gutter: false }));
  for (const t of snapshot.tickets) lines.push(renderRow(t, { layout, now, style, gutter: false, by: layout.by ? byCell(t, snapshot.teams?.[t.project_id]) : null }));
  if (snapshot.tickets.length === 0) lines.push(style.dim('no tickets'));
  return lines.join('\n');
}

export function renderJson(snapshot: Snapshot): string {
  return JSON.stringify(
    snapshot.tickets.map((t) => ({
      ...t,
      tags: JSON.parse(t.tags || '{}'),
      labels: JSON.parse(t.labels || '[]'),
    })),
    null,
    2,
  );
}
