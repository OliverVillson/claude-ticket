import { describe, expect, test } from 'bun:test';
import { ancestorsOf, buildRows, pathNames, renderTreeRow, revealed, subtreeIds, treeKey } from '../../src/tui/tree.ts';
import { makeStyle } from '../../src/tui/style.ts';
import { displayWidth } from '../../src/tui/format.ts';

const projects = [
  { id: 1, name: 'web', parent_id: null },
  { id: 2, name: 'api', parent_id: null },
  { id: 3, name: 'web-ui', parent_id: 1 },
  { id: 4, name: 'web-ui-forms', parent_id: 3 },
  { id: 5, name: 'orphan', parent_id: 99 },
];
const names = (open: number[]) => buildRows(projects, new Set(open)).map((r) => '  '.repeat(r.depth) + r.name);

describe('tree rows', () => {
  test('collapsed by default, orphans become roots', () => {
    expect(names([])).toEqual(['all projects', '  web', '  api', '  orphan']);
  });
  test('expanded projects show their children depth first', () => {
    expect(names([1, 3])).toEqual(['all projects', '  web', '    web-ui', '      web-ui-forms', '  api', '  orphan']);
  });
  test('cycles do not loop forever', () => {
    const cyc = [{ id: 1, name: 'a', parent_id: 2 }, { id: 2, name: 'b', parent_id: 1 }];
    expect(buildRows(cyc, new Set([1, 2])).length).toBeGreaterThanOrEqual(1);
    expect(subtreeIds(cyc, 1)!.size).toBe(2);
  });
});

describe('scope', () => {
  test('a project covers its whole subtree, a subproject only itself down', () => {
    expect([...subtreeIds(projects, 1)!].sort()).toEqual([1, 3, 4]);
    expect([...subtreeIds(projects, 3)!].sort()).toEqual([3, 4]);
    expect([...subtreeIds(projects, 4)!]).toEqual([4]);
    expect(subtreeIds(projects, null)).toBeNull();
  });
  test('ancestors and paths', () => {
    expect(ancestorsOf(projects, 4)).toEqual([3, 1]);
    expect(pathNames(projects, 4)).toEqual(['web', 'web-ui', 'web-ui-forms']);
    expect(pathNames(projects, null)).toEqual([]);
    expect([...revealed(projects, new Set(), 4)].sort()).toEqual([1, 3]);
  });
});

describe('arrow keys', () => {
  const st = (selected: number | null, open: number[] = []) => ({ selected, expanded: new Set(open) });
  test('down and up walk visible rows', () => {
    expect(treeKey(projects, st(null), 'down').selected).toBe(1);
    expect(treeKey(projects, st(1), 'down').selected).toBe(2);
    expect(treeKey(projects, st(1), 'up').selected).toBeNull();
    expect(treeKey(projects, st(null), 'up').selected).toBeNull();
  });
  test('right opens, then enters, then hands over to the tickets', () => {
    let r = treeKey(projects, st(1), 'right');
    expect([r.selected, [...r.expanded]]).toEqual([1, [1]]);
    r = treeKey(projects, { selected: 1, expanded: r.expanded }, 'right');
    expect(r.selected).toBe(3);
    r = treeKey(projects, st(2), 'right');
    expect(r.focusTickets).toBe(true);
  });
  test('left collapses, then goes to the parent', () => {
    let r = treeKey(projects, st(1, [1]), 'left');
    expect([r.selected, r.expanded.has(1)]).toEqual([1, false]);
    r = treeKey(projects, st(3, [1]), 'left');
    expect(r.selected).toBe(1);
    r = treeKey(projects, st(1), 'left');
    expect(r.selected).toBeNull();
  });
});

describe('row rendering', () => {
  test('lines are exactly the pane width, long names truncated', () => {
    const st = makeStyle(false);
    const rows = buildRows([{ id: 1, name: 'a-very-long-project-name-indeed', parent_id: null }], new Set());
    for (const r of rows) for (const sel of [true, false]) expect(displayWidth(renderTreeRow(r, { st, selected: sel, focused: true, width: 24, count: 12 }))).toBe(24);
    expect(renderTreeRow(rows[1]!, { st, selected: true, focused: true, width: 24, count: 12 })).toContain('❯');
  });
});
