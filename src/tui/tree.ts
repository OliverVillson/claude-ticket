import { fit } from './format.ts';
import type { Style } from './style.ts';

/**
 * The project tree of the two-pane layout: pure functions over a flat project list so
 * selection changes never touch the database. Subprojects point at their parent with
 * `parent_id`; a project without one (or whose parent is gone) is a root.
 */
export interface TreeProject {
  id: number;
  name: string;
  parent_id?: number | null;
}

export interface TreeRow {
  /** null = the "all projects" root row */
  id: number | null;
  name: string;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

export const CURSOR = '❯';

function childMap(projects: TreeProject[]): Map<number | null, TreeProject[]> {
  const ids = new Set(projects.map((p) => p.id));
  const kids = new Map<number | null, TreeProject[]>();
  for (const p of projects) {
    const parent = p.parent_id != null && ids.has(p.parent_id) && p.parent_id !== p.id ? p.parent_id : null;
    const list = kids.get(parent);
    if (list) list.push(p);
    else kids.set(parent, [p]);
  }
  return kids;
}

/** Visible rows, depth first; children of a collapsed project are left out. The first row is "all projects". */
export function buildRows(projects: TreeProject[], expanded: ReadonlySet<number>): TreeRow[] {
  const kids = childMap(projects);
  const rows: TreeRow[] = [{ id: null, name: 'all projects', depth: 0, hasChildren: false, expanded: true }];
  const seen = new Set<number>();
  const walk = (parent: number | null, depth: number) => {
    for (const p of kids.get(parent) ?? []) {
      if (seen.has(p.id)) continue; // guards against cycles
      seen.add(p.id);
      const hasChildren = (kids.get(p.id)?.length ?? 0) > 0;
      const open = hasChildren && expanded.has(p.id);
      rows.push({ id: p.id, name: p.name, depth, hasChildren, expanded: open });
      if (open) walk(p.id, depth + 1);
    }
  };
  walk(null, 1);
  return rows;
}

/** Ids of a project and everything under it; null (all projects) means no restriction. */
export function subtreeIds(projects: TreeProject[], id: number | null): Set<number> | null {
  if (id == null) return null;
  const kids = childMap(projects);
  const out = new Set<number>();
  const walk = (i: number) => {
    if (out.has(i)) return;
    out.add(i);
    for (const c of kids.get(i) ?? []) walk(c.id);
  };
  walk(id);
  return out;
}

/** Ancestors of a project, nearest first. */
export function ancestorsOf(projects: TreeProject[], id: number | null): number[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const out: number[] = [];
  let cur = id != null ? byId.get(id) : undefined;
  while (cur && cur.parent_id != null && byId.has(cur.parent_id) && !out.includes(cur.parent_id)) {
    out.push(cur.parent_id);
    cur = byId.get(cur.parent_id);
  }
  return out;
}

/** Names from the top-level project down to `id`, for breadcrumbs. */
export function pathNames(projects: TreeProject[], id: number | null): string[] {
  if (id == null) return [];
  const byId = new Map(projects.map((p) => [p.id, p]));
  return [...ancestorsOf(projects, id).reverse(), id].map((i) => byId.get(i)?.name ?? '?');
}

export type TreeKey = 'up' | 'down' | 'left' | 'right';

export interface TreeState {
  /** selected project id (null = all projects) */
  selected: number | null;
  expanded: Set<number>;
}

export interface TreeStep extends TreeState {
}

/**
 * One arrow key in the tree. Up/down move through visible rows; right opens a collapsed project,
 * then steps into its first subproject, then (on a leaf) does nothing (only tab moves between windows); left collapses an
 * open project, else jumps to the parent.
 */
export function treeKey(projects: TreeProject[], state: TreeState, key: TreeKey): TreeStep {
  const rows = buildRows(projects, state.expanded);
  const i = Math.max(0, rows.findIndex((r) => r.id === state.selected));
  const row = rows[i]!;
  const keep = { selected: state.selected, expanded: state.expanded };
  if (key === 'up') return { ...keep, selected: rows[Math.max(0, i - 1)]!.id };
  if (key === 'down') return { ...keep, selected: rows[Math.min(rows.length - 1, i + 1)]!.id };
  if (key === 'right') {
    if (row.id == null) return keep;
    if (row.hasChildren && !row.expanded) return { selected: row.id, expanded: new Set(state.expanded).add(row.id) };
    if (row.hasChildren && row.expanded) return { ...keep, selected: rows[i + 1]!.id };
    return keep;
  }
  // left
  if (row.id == null) return keep;
  if (row.expanded) {
    const next = new Set(state.expanded);
    next.delete(row.id);
    return { selected: row.id, expanded: next };
  }
  const parent = ancestorsOf(projects, row.id)[0];
  return { ...keep, selected: parent ?? null };
}

/** Make sure the ancestors of `id` are open so its row is visible. */
export function revealed(projects: TreeProject[], expanded: ReadonlySet<number>, id: number | null): Set<number> {
  const out = new Set(expanded);
  for (const a of ancestorsOf(projects, id)) out.add(a);
  return out;
}

/** One tree line, exactly `width` cells: marker, indent, disclosure triangle, name, ticket count. */
export function renderTreeRow(row: TreeRow, o: { st: Style; selected: boolean; focused: boolean; width: number; count: number }): string {
  const { st, width } = o;
  const marker = o.selected ? (o.focused ? st.accent(CURSOR) : st.dim(CURSOR)) : ' ';
  const twisty = row.hasChildren ? (row.expanded ? '▾' : '▸') : ' ';
  const count = row.id == null || o.count > 0 ? String(o.count) : '';
  const head = ' ' + marker + ' ' + '  '.repeat(Math.max(0, row.depth - (row.id == null ? 0 : 1)));
  const room = Math.max(1, width - 5 - 2 * Math.max(0, row.depth - (row.id == null ? 0 : 1)) - (count ? count.length + 1 : 0));
  const label = fit(row.name, room);
  const name = o.selected ? (o.focused ? st.bold(st.accent(label)) : st.text(label)) : row.id == null ? st.dim(label) : st.text(label);
  return st.base(head + st.dim(twisty) + ' ' + name + (count ? ' ' + st.dim(count.padStart(0)) : ''));
}
