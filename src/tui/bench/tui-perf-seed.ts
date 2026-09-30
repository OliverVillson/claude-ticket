// Seed TICKET_HOME with N tickets (default 500) for timing the list view: bun run src/tui/bench/tui-perf-seed.ts 500
import { openDb } from '../../db/db.ts';
import { createProject, createTicket, updateTicket } from '../../db/queries.ts';
const n = Number(process.argv[2] ?? 500);
const db = openDb();
const a = createProject(db, { name: 'web', path: '/tmp/web' });
const b = createProject(db, { name: 'api', path: '/tmp/api' });
const statuses = ['running', 'todo', 'todo', 'done', 'failed', 'blocked', 'paused', 'todo'] as const;
db.transaction(() => {
  for (let i = 0; i < n; i++) {
    const t = createTicket(db, {
      project_id: i % 3 ? a.id : b.id,
      name: `Ticket ${i + 1}: refactor the ${['auth', 'billing', 'search', 'docs', 'ui'][i % 5]} module`,
      query: `Do task ${i + 1} carefully and add tests.`,
      tags: i % 2 ? { model: 'sonnet' } : { model: 'opus', effort: 'high' },
      labels: i % 7 === 0 ? ['bug'] : [],
      priority: (i % 5) + 1,
    });
    updateTicket(db, t.id, { status: statuses[i % statuses.length]!, cost_usd: (i % 9) * 0.13 });
  }
})();
console.log(`seeded ${n} tickets in ${process.env.TICKET_HOME}`);
