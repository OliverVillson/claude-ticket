import { describe, expect, test } from 'bun:test';
import { parseTags, tokenize } from '../src/core/tags.ts';
import { DEFAULT_ALLOWED_TOOLS, TOOL_PRESETS, describeTools, parseTools, toolsToSdk, validateTools } from '../src/core/tools.ts';
import { effectiveSettings, workerSdkOptions } from '../src/orchestrator/worker.ts';
import { createProject, inheritedProject } from '../src/db/queries.ts';
import { openDb } from '../src/db/db.ts';
import type { Project, TicketView } from '../src/db/types.ts';

const tv = (tags: object = {}): TicketView => ({
  id: 7, project_id: 1, name: 't', query: 'q', tags: JSON.stringify(tags), labels: '[]', priority: 3, status: 'todo', attempts: 0,
  session_id: null, cost_usd: 0, error: null, depends_on: null, created_at: 0, updated_at: 0, started_at: null, finished_at: null,
  project: 'web', project_path: '/work/web',
});
const proj = (over: Partial<Project> = {}): Project => ({ id: 1, name: 'web', path: '/work/web', is_default: 1, default_model: null, default_effort: null, default_tools: null, concurrency: null, created_at: 0, parent_id: null, ...over });

describe('tools values', () => {
  test('presets and canonical form', () => {
    for (const p of TOOL_PRESETS) expect(validateTools(p.name.toUpperCase())).toBe(p.name);
    expect(validateTools('allow: Read , Grep ;deny:Bash(rm *)')).toBe('allow:Read,Grep;deny:Bash(rm *)');
    expect(parseTools('allow:Read,Bash(git log *, git diff *)').allow).toEqual(['Read', 'Bash(git log *, git diff *)']);
  });
  test.each([
    ['', /needs a value/],
    ['everything', /must be standard/],
    ['allow:read', /did you mean Read/],
    ['allow:Read,,Grep', /empty entry/],
    ['allow:Bash(git', /unbalanced/],
    ['allow:Read;allow:Grep', /twice/],
    ['allow:', /empty entry/],
    ['allow:Re ad', /not a tool name/],
  ])('rejects %p', (v, re) => expect(() => validateTools(v)).toThrow(re));
  test('describe', () => {
    expect(describeTools(null)).toContain('regular');
    expect(describeTools('allow:Read;deny:Bash')).toBe('only Read; never Bash');
    expect(describeTools('deny:Bash(rm *)')).toContain('except');
  });
});

describe('tools in tags', () => {
  test('tokenizer keeps the list and parens together', () => {
    expect(tokenize('bug tools=allow:Read,Grep,Bash(git *) priority=2')).toEqual(['bug', 'tools=allow:Read,Grep,Bash(git *)', 'priority=2']);
    expect(tokenize('tools="allow:Read,Grep" model=opus')).toEqual(['tools=allow:Read,Grep', 'model=opus']);
  });
  test('parseTags validates and canonicalises', () => {
    expect(parseTags('tools=ReadOnly').tags.tools).toBe('readonly');
    expect(parseTags('tools=allow:Read,Grep,Bash(git *)').tags.tools).toBe('allow:Read,Grep,Bash(git *)');
    expect(() => parseTags('tools=bogus')).toThrow(/tools must be/);
  });
});

describe('tools to SDK options', () => {
  test('standard = no restriction, default git rules', () => {
    const o = workerSdkOptions(tv(), proj());
    expect(o.tools).toBeUndefined();
    expect(o.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(o.disallowedTools).toContain('Bash(git push:*)');
  });
  test('readonly has no Bash', () => {
    const o = workerSdkOptions(tv({ tools: 'readonly' }), proj());
    expect(o.tools).toEqual(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);
    expect(o.allowedTools).not.toContain('Bash(git commit:*)');
  });
  test('none disables all built-in tools', () => {
    expect(workerSdkOptions(tv({ tools: 'none' }), proj()).tools).toEqual([]);
  });
  test('custom allow and deny', () => {
    const o = workerSdkOptions(tv({ tools: 'allow:Read,Grep,Bash(git *);deny:Bash(git push *)' }), proj());
    expect(o.tools).toEqual(['Read', 'Grep', 'Bash']);
    expect(o.allowedTools).toEqual(['Read', 'Grep', 'Bash(git *)']);
    expect(o.disallowedTools).toContain('Bash(git push *)');
    expect(o.disallowedTools).toContain('Bash(git push:*)');
  });
  test('deny only keeps the standard set', () => {
    const o = workerSdkOptions(tv({ tools: 'deny:WebFetch' }), proj());
    expect(o.tools).toBeUndefined();
    expect(o.disallowedTools).toContain('WebFetch');
  });
  test('permission interplay: bypass and plan skip auto-allow rules but keep the restriction and explicit denies', () => {
    const b = workerSdkOptions(tv({ tools: 'allow:Read;deny:Bash', permission: 'bypass' }), proj());
    expect(b.tools).toEqual(['Read']);
    expect(b.allowedTools).toBeUndefined();
    expect(b.disallowedTools).toEqual(['Bash']);
    expect(workerSdkOptions(tv({ tools: 'readonly', permission: 'plan' }), proj()).tools).toBeDefined();
    expect(toolsToSdk('standard', 'bypass')).toEqual({});
  });
  test('ticket beats project default', () => {
    expect(effectiveSettings(tv(), proj({ default_tools: 'edit' })).tools).toBe('edit');
    expect(effectiveSettings(tv({ tools: 'none' }), proj({ default_tools: 'edit' })).tools).toBe('none');
    expect(effectiveSettings(tv(), proj()).tools).toBe('standard');
  });
});

describe('project default tools inherit down the tree', () => {
  test('child takes the nearest ancestor value', () => {
    const db = openDb(':memory:');
    const a = createProject(db, { name: 'a', path: '/tmp/a', defaultTools: 'readonly' });
    const b = createProject(db, { name: 'b', path: '/tmp/a/b', parentId: a.id });
    const c = createProject(db, { name: 'c', path: '/tmp/a/b/c', parentId: b.id, defaultTools: 'edit' });
    expect(inheritedProject(db, b).default_tools).toBe('readonly');
    expect(inheritedProject(db, c).default_tools).toBe('edit');
  });
});
