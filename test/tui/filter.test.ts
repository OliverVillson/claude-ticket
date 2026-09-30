import { describe, expect, test } from 'bun:test';
import type { TicketView } from '../../src/db/types.ts';
import { applyFilter, parseFilter } from '../../src/tui/filter.ts';

function t(over: Partial<TicketView>): TicketView {
  return {
    id: 1, project_id: 1, name: 'Fix login', query: 'redirect loop on expired cookie', tags: JSON.stringify({ model: 'opus', effort: 'high' }),
    labels: JSON.stringify(['bug', 'auth']), priority: 2, status: 'todo', attempts: 0, session_id: null, cost_usd: 0, error: null, depends_on: null,
    created_at: 0, updated_at: 0, started_at: null, finished_at: null, project: 'web', project_path: '/w', ...over,
  };
}

const list = [
  t({ id: 1, name: 'Fix login', priority: 2, status: 'running' }),
  t({ id: 2, name: 'Write docs', query: 'api reference', tags: '{}', labels: JSON.stringify(['docs']), priority: 4, status: 'todo', project: 'api' }),
  t({ id: 3, name: 'Speed up list', query: 'perf', tags: JSON.stringify({ model: 'sonnet' }), labels: '[]', priority: 0, status: 'failed' }),
  t({ id: 4, name: 'Old thing', priority: 5, status: 'done', labels: '[]' }),
];
const names = (q: string) => applyFilter(list, q).map((x) => x.id);

describe('filter language', () => {
  test('empty query keeps everything', () => {
    expect(names('')).toEqual([1, 2, 3, 4]);
    expect(names('   ')).toEqual([1, 2, 3, 4]);
  });
  test('plain words match name, query, labels, tags, project and status', () => {
    expect(names('login')).toEqual([1]);
    expect(names('reference')).toEqual([2]);
    expect(names('docs')).toEqual([2]);
    expect(names('sonnet')).toEqual([3]);
    expect(names('running')).toEqual([1]);
    expect(names('LOGIN')).toEqual([1]);
  });
  test('terms are ANDed', () => {
    expect(names('login running')).toEqual([1]);
    expect(names('login docs')).toEqual([]);
  });
  test('labels, projects and statuses have their own prefixes', () => {
    expect(names('#bug')).toEqual([1]);
    expect(names('label:doc')).toEqual([2]);
    expect(names('@api')).toEqual([2]);
    expect(names('project:web')).toEqual([1, 3, 4]);
    expect(names('status:fail')).toEqual([3]);
    expect(names('s:done')).toEqual([4]);
  });
  test('priority equals, ranges and now', () => {
    expect(names('p2')).toEqual([1]);
    expect(names('priority:4')).toEqual([2]);
    expect(names('p<=2')).toEqual([1, 3]);
    expect(names('p>=4')).toEqual([2, 4]);
    expect(names('pnow')).toEqual([3]);
    expect(names('p0')).toEqual([3]);
  });
  test('key:value matches a tag', () => {
    expect(names('model:opus')).toEqual([1, 4]);
    expect(names('effort:high')).toEqual([1, 4]);
    expect(names('model:haiku')).toEqual([]);
  });
  test('a leading dash negates', () => {
    expect(names('-done')).toEqual([1, 2, 3]);
    expect(names('#bug -status:done')).toEqual([1]);
    expect(names('-#bug')).toEqual([2, 3, 4]);
  });
  test('parse keeps terms in order', () => {
    const terms = parseFilter('#bug p1 -x model:opus');
    expect(terms.map((x) => x.kind)).toEqual(['label', 'priority', 'text', 'tag']);
    expect(terms[2]!.negate).toBe(true);
  });
});
