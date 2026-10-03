/**
 * Pure layout maths for the list: column widths for a given terminal width and the scroll
 * window that keeps the cursor visible. Kept free of React so it can be unit-tested and reused
 * by the plain renderer.
 */

export interface RowLayout {
  /** total inner width the row must fill */
  total: number;
  name: number;
  project: number; // 0 when hidden
  by: number; // who added the ticket; 0 when the project has no team
  priority: number; // 0 when hidden
  model: number; // 0 when hidden
  status: number;
  age: number; // 0 when hidden
  cost: number; // 0 when hidden
}

/** Fixed prefix: cursor marker + space + status glyph + space. */
export const ROW_PREFIX = 4;
export const GAP = 2;

export function computeLayout(innerWidth: number, opts: { showProject?: boolean; showCost?: boolean; showBy?: boolean } = {}): RowLayout {
  const total = Math.max(20, innerWidth);
  const showProject = !!opts.showProject;
  const showCost = opts.showCost !== false;

  // Widths in priority order of what to drop first when narrow.
  let cost = showCost ? 7 : 0;
  let age = 4;
  let model = 14;
  let priority = 3;
  let project = showProject ? 12 : 0;
  let by = opts.showBy ? 12 : 0;
  const status = 8;

  const fixed = () => ROW_PREFIX + [project, by, priority, model, status, age, cost].filter(Boolean).reduce((a, b) => a + b + GAP, 0);
  const minName = 12;

  if (total - fixed() < minName) cost = 0;
  if (total - fixed() < minName) model = 10;
  if (total - fixed() < minName) by = by ? 8 : 0;
  if (total - fixed() < minName) project = showProject ? 8 : 0;
  if (total - fixed() < minName) model = 0;
  if (total - fixed() < minName) age = 0;
  if (total - fixed() < minName) project = 0;
  if (total - fixed() < minName) by = 0;
  if (total - fixed() < minName) priority = 0;

  const name = Math.max(4, total - fixed());
  return { total, name, project, by, priority, model, status, age, cost };
}

/** Scroll `top` so that `cursor` is inside [top, top + height). */
export function scrollTop(top: number, cursor: number, height: number, count: number): number {
  const h = Math.max(1, height);
  const maxTop = Math.max(0, count - h);
  let t = Math.min(Math.max(0, top), maxTop);
  if (cursor < t) t = cursor;
  else if (cursor >= t + h) t = cursor - h + 1;
  return Math.min(Math.max(0, t), maxTop);
}

export function clampCursor(cursor: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(0, cursor), count - 1);
}

/** Rows available for ticket lines given the terminal height and the frame's fixed lines. */
export function viewportRows(terminalRows: number, chrome: number, min = 3, max = 200): number {
  const rows = (terminalRows || 24) - chrome;
  return Math.max(min, Math.min(max, rows));
}
