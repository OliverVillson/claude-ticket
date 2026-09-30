import type { TicketView } from '../db/types.ts';
import type { RowLayout } from './layout.ts';
import { fit, fmtCost, modelEffort, nameCell, priorityText, relTime } from './format.ts';
import type { Style } from './style.ts';
import { CURSOR_GLYPH, SPINNER_FRAMES, STATUS_STYLE, paint, paintPriority, paintStatus } from './theme.ts';

export interface RowOptions {
  layout: RowLayout;
  now: number;
  style: Style;
  /** draw the cursor marker and highlight; false for the plain table */
  selected?: boolean;
  /** show the `❯` gutter at all (the plain table has none) */
  gutter?: boolean;
  /** spinner frame for running tickets; undefined shows the static glyph */
  spinner?: number;
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
  const nc = nameCell(t, layout.name);
  let out = '';
  if (o.gutter !== false) out += o.selected ? st.accent(CURSOR_GLYPH) + ' ' : '  ';
  out += paintStatus(st, t.status, glyph) + ' ';
  out += o.selected ? paint(st, 'accent', nc.name, { bold: true }) : st.text(nc.name);
  if (nc.labels) out += st.dim(nc.labels);
  if (layout.project) out += '  ' + st.dim(fit(t.project, layout.project));
  if (layout.priority) out += '  ' + paintPriority(st, t.priority, fit(priorityText(t.priority), layout.priority));
  if (layout.model) out += '  ' + st.dim(fit(modelEffort(t), layout.model));
  out += '  ' + paintStatus(st, t.status, fit(info.label, layout.status));
  if (layout.age) out += '  ' + st.dim(fit(relTime(t.updated_at, o.now), layout.age, 'right'));
  if (layout.cost) out += '  ' + st.dim(fit(fmtCost(t.cost_usd), layout.cost, 'right'));
  return out;
}

/** Column headings matching `renderRow`, for the plain table. */
export function renderHeader(o: { layout: RowLayout; style: Style; gutter?: boolean }): string {
  const { layout, style: st } = o;
  let out = o.gutter === false ? '' : '  ';
  out += '  ' + fit('name', layout.name);
  if (layout.project) out += '  ' + fit('project', layout.project);
  if (layout.priority) out += '  ' + fit('pr', layout.priority);
  if (layout.model) out += '  ' + fit('model', layout.model);
  out += '  ' + fit('status', layout.status);
  if (layout.age) out += '  ' + fit('age', layout.age, 'right');
  if (layout.cost) out += '  ' + fit('cost', layout.cost, 'right');
  return st.dim(out);
}
