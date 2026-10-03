import type { TicketView } from '../db/types.ts';
import type { RowLayout } from './layout.ts';
import { fit, fmtCost, modelEffort, nameCell, priorityText, relTime } from './format.ts';
import type { Style } from './style.ts';
import { isResolved } from './thread.ts';
import { CURSOR_GLYPH, SPINNER_FRAMES, STATUS_STYLE, paint, paintPriority, paintStatus } from './theme.ts';

export interface RowOptions {
  layout: RowLayout;
  now: number;
  style: Style;
  /** draw the cursor marker and highlight; false for the plain table */
  selected?: boolean;
  /** show the `❯` gutter at all (the plain table has none) */
  gutter?: boolean;
  /** the worker asked a decision nobody answered: a `?` after the name, and a resolved row stays full size */
  asking?: boolean;
  /** spinner frame for running tickets; undefined shows the static glyph */
  spinner?: number;
  /** who added the ticket (team projects); shown when the layout has a `by` column */
  by?: string | null;
}

/**
 * One list row as a single ANSI string, exactly `layout.total` cells wide or narrower:
 *
 *   ❯ ● Fix login  #bug          web  p1  opus/high  running   4m  $0.42
 */
export function renderRow(t: TicketView, o: RowOptions): string {
  const { layout, style: st } = o;
  const info = STATUS_STYLE[t.status];
  const glyph = t.status === 'running' && o.spinner != null ? SPINNER_FRAMES[o.spinner % SPINNER_FRAMES.length]! : info.glyph;
  if (isResolved(t) && !o.asking) {
    // A resolved thread collapses to one quiet line: glyph, name, age.
    const age = relTime(t.updated_at, o.now);
    const room = Math.max(4, layout.total - (o.gutter !== false ? 4 : 2) - age.length - 2);
    const name = fit(t.name, Math.min(room, Math.max(4, layout.name)));
    const head = (o.gutter !== false ? (o.selected ? st.accent(CURSOR_GLYPH) + ' ' : '  ') : '') + st.dim(glyph + ' ');
    return st.base(head + (o.selected ? paint(st, 'accent', name, { bold: true }) : st.dim(name)) + st.dim('  ' + age));
  }
  const nc = nameCell(t, layout.name - (o.asking ? 2 : 0));
  let out = '';
  if (o.gutter !== false) out += o.selected ? st.accent(CURSOR_GLYPH) + ' ' : '  ';
  out += paintStatus(st, t.status, glyph) + ' ';
  out += o.selected ? paint(st, 'accent', nc.name, { bold: true }) : st.text(nc.name);
  if (o.asking) out += st.accent(' ?');
  if (nc.labels) out += st.dim(nc.labels);
  if (layout.project) out += '  ' + st.dim(fit(t.project, layout.project));
  if (layout.by) out += '  ' + st.dim(fit(o.by ?? '-', layout.by));
  if (layout.priority) out += '  ' + paintPriority(st, t.priority, fit(priorityText(t.priority), layout.priority));
  if (layout.model) out += '  ' + st.dim(fit(modelEffort(t), layout.model));
  out += '  ' + paintStatus(st, t.status, fit(info.label, layout.status));
  if (layout.age) out += '  ' + st.dim(fit(relTime(t.updated_at, o.now), layout.age, 'right'));
  if (layout.cost) out += '  ' + st.dim(fit(fmtCost(t.cost_usd), layout.cost, 'right'));
  return st.base(out);
}

/** Column headings matching `renderRow`, for the plain table. */
export function renderHeader(o: { layout: RowLayout; style: Style; gutter?: boolean }): string {
  const { layout, style: st } = o;
  let out = o.gutter === false ? '' : '  ';
  out += '  ' + fit('name', layout.name);
  if (layout.project) out += '  ' + fit('project', layout.project);
  if (layout.by) out += '  ' + fit('by', layout.by);
  if (layout.priority) out += '  ' + fit('pr', layout.priority);
  if (layout.model) out += '  ' + fit('model', layout.model);
  out += '  ' + fit('status', layout.status);
  if (layout.age) out += '  ' + fit('age', layout.age, 'right');
  if (layout.cost) out += '  ' + fit('cost', layout.cost, 'right');
  return st.dim(out);
}
