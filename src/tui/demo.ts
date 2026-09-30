/**
 * Try the list view without the rest of the CLI:
 *
 *   bun run src/tui/demo.ts            # 24 tickets in two projects, temp database
 *   bun run src/tui/demo.ts web        # start on one project
 *   bun run src/tui/demo.ts --n 500    # stress test
 *   bun run src/tui/demo.ts --plain
 *
 * Uses a throwaway TICKET_HOME so nothing touches ~/.ticket.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ticket-demo-'));
process.env.TICKET_HOME = home;

const { openDb } = await import('../db/db.ts');
const { createProject, createTicket, updateTicket, createRun, finishRun, setState } = await import('../db/queries.ts');
const { STATE } = await import('../db/types.ts');
const { openList, renderPlain, renderJson, loadSnapshot } = await import('./index.tsx');

const argv = process.argv.slice(2);
const nIdx = argv.indexOf('--n');
const n = nIdx >= 0 ? Number(argv[nIdx + 1]) : 24;
const rest = nIdx >= 0 ? argv.filter((_, i) => i !== nIdx && i !== nIdx + 1) : argv;

const db = openDb();
const web = createProject(db, { name: 'web', path: join(home, 'web'), defaultModel: 'sonnet' });
const api = createProject(db, { name: 'api', path: join(home, 'api') });
mkdirSync(join(home, 'logs', 'web'), { recursive: true });

const names = [
  'Fix login redirect loop',
  'Add dark mode toggle',
  'Write API docs for /tickets',
  'Migrate to Bun test runner',
  'Speed up list rendering',
  'Handle rate limit pause',
  'Refactor auth middleware',
  'Add e2e smoke test',
];
const statuses = ['running', 'todo', 'todo', 'done', 'failed', 'blocked', 'paused', 'todo'] as const;
const models = ['opus', 'sonnet', '', 'haiku', 'opus', '', 'sonnet', ''];
const efforts = ['high', '', 'max', '', 'xhigh', 'low', '', ''];
const labelSets = [['bug', 'auth'], ['ui'], ['docs'], [], ['perf'], ['orchestrator'], ['refactor', 'auth'], ['test']];

for (let i = 0; i < n; i++) {
  const k = i % names.length;
  const project = i % 3 === 0 ? api : web;
  const tags: Record<string, string> = {};
  if (models[k]) tags.model = models[k]!;
  if (efforts[k]) tags.effort = efforts[k]!;
  if (k === 5) tags['max-turns'] = '30';
  const t = createTicket(db, {
    project_id: project.id,
    name: n > names.length ? `${names[k]} #${i + 1}` : names[k]!,
    query:
      k === 0
        ? 'Users get bounced between /login and /dashboard when the session cookie has expired. Reproduce with an expired cookie, find the redirect in the auth middleware, fix it, and add a regression test.'
        : `${names[k]}. Keep the change small and add a test.`,
    tags,
    labels: labelSets[k],
    priority: (i % 5) + 1,
  });
  const status = statuses[k]!;
  const ago = (i + 1) * 7 * 60_000;
  const started = Date.now() - ago;
  if (status !== 'todo') {
    const run = createRun(db, t.id, status === 'running' || status === 'done' ? join(home, 'logs', 'web', `${t.id}-1.jsonl`) : null);
    if (run.log_path) {
      writeFileSync(
        run.log_path,
        [
          JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-1' }),
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the auth middleware first.' }] } }),
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/auth/middleware.ts' } }] } }),
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/auth/middleware.ts' } }] } }),
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'bun test src/auth' } }] } }),
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'The redirect happened because the expired cookie still passed the presence check. Fixed and covered by a test.' }] } }),
          ...(status === 'done' ? [JSON.stringify({ type: 'result', subtype: 'success', num_turns: 14, total_cost_usd: 0.42, result: 'TICKET: done' })] : []),
        ].join('\n') + '\n',
      );
    }
    if (status !== 'running') finishRun(db, run.id, { outcome: status === 'done' ? 'done' : status === 'failed' ? 'failed' : status === 'blocked' ? 'blocked' : 'rate_limited', turns: 14, cost_usd: 0.42 });
    updateTicket(db, t.id, {
      status,
      attempts: status === 'failed' ? 2 : 1,
      started_at: started,
      finished_at: status === 'running' ? null : started + 5 * 60_000,
      cost_usd: 0.42,
      error: status === 'failed' ? 'error_max_turns: hit the 50-turn cap before finishing' : status === 'blocked' ? 'Which OAuth provider should the new flow use, Google or GitHub?' : null,
      session_id: status === 'paused' || status === 'running' ? 'sess_0123456789abcdef' : null,
    });
  }
}
setState(db, STATE.pid, process.pid);
setState(db, STATE.heartbeat, Date.now());

if (rest.includes('--plain') || rest.includes('--json') || !process.stdout.isTTY) {
  const snap = loadSnapshot(db);
  console.log(rest.includes('--json') ? renderJson(snap) : renderPlain(snap, { width: process.stdout.columns || 100 }));
} else {
  // Keep the heartbeat fresh so the badge reads "orchestrator on" during the demo.
  setInterval(() => setState(db, STATE.heartbeat, Date.now()), 5000).unref();
  const project = rest.find((a) => !a.startsWith('-'));
  const pid = project === 'web' ? web.id : project === 'api' ? api.id : undefined;
  await openList({ db, projectId: pid });
}
