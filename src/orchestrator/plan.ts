/**
 * `salu plan "name"`: ask Claude to split one ticket into sub-tickets, show them, and add them on approval.
 */
import { createInterface } from 'node:readline';
import type { TicketView } from '../db/types.ts';
import { openDb } from '../db/db.ts';
import { createTicket, getProjectById, inheritedProject, getTicket, updateTicket } from '../db/queries.ts';
import { CliError } from '../core/errors.ts';
import { bold, cyan, dim, green, yellow } from '../core/ansi.ts';
import { parseTags } from '../core/tags.ts';
import { effectiveSettings, workerEnv } from './worker.ts';

export interface PlannedTicket {
  name: string;
  query: string;
  tags: string;
  priority: number;
}

const MIN_SUBTICKETS = 2;
const MAX_SUBTICKETS = 8;

export function plannerPrompt(t: TicketView): string {
  return [
    `Split the following ticket into ${MIN_SUBTICKETS} to ${MAX_SUBTICKETS} smaller sub-tickets that a separate Claude Code agent can each finish on its own, in order of dependency.`,
    'You may read the project folder to ground the split, but do not change anything.',
    '',
    `Ticket name: ${t.name}`,
    `Project: ${t.project}`,
    `Ticket:`,
    t.query.trim(),
    '',
    'Reply with ONLY a JSON array, no prose and no code fence. Each element:',
    '{"name": "short unique name", "query": "the full instructions for the agent, self-contained", "tags": "space separated key=value tags such as effort=medium model=sonnet, or empty", "priority": 1-5 (1 highest, 3 default)}',
  ].join('\n');
}

/** Pull the JSON array out of a planner reply, tolerating a code fence or a line of prose around it. */
export function parsePlan(text: string): PlannedTicket[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new CliError('the planner did not return a JSON array');
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (e: any) {
    throw new CliError(`the planner's JSON could not be read: ${e?.message ?? e}`);
  }
  if (!Array.isArray(raw)) throw new CliError('the planner did not return a JSON array');
  const out: PlannedTicket[] = [];
  const seen = new Set<string>();
  for (const item of raw as any[]) {
    const name = String(item?.name ?? '').trim();
    const query = String(item?.query ?? '').trim();
    if (!name || !query) continue;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const prio = Number(item?.priority);
    out.push({ name, query, tags: typeof item?.tags === 'string' ? item.tags : Array.isArray(item?.tags) ? item.tags.join(' ') : '', priority: Number.isInteger(prio) && prio >= 1 && prio <= 5 ? prio : 3 });
  }
  if (out.length < MIN_SUBTICKETS) throw new CliError(`the planner returned ${out.length} usable sub-ticket${out.length === 1 ? '' : 's'}; need at least ${MIN_SUBTICKETS}`);
  return out.slice(0, MAX_SUBTICKETS);
}

/** Canned split for `SALU_WORKER=fake`. */
export function fakePlan(t: TicketView): PlannedTicket[] {
  return [
    { name: `${t.name} 1`, query: `FAKE:done first half of ${t.name}`, tags: '', priority: 3 },
    { name: `${t.name} 2`, query: `FAKE:done second half of ${t.name}`, tags: '', priority: 3 },
  ];
}

async function askClaude(t: TicketView): Promise<PlannedTicket[]> {
  const db = openDb();
  const base = getProjectById(db, t.project_id);
  const project = base ? inheritedProject(db, base) : null;
  const s = effectiveSettings(t, project);
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const options: Record<string, any> = {
    cwd: t.project_path,
    maxTurns: 3,
    permissionMode: 'plan',
    permissionPrompts: 'none',
    persistSession: false,
    systemPrompt: 'You break large engineering tickets into smaller ones. Answer with a JSON array only.',
    env: workerEnv(),
  };
  if (s.model) options.model = s.model;
  if (s.effort) options.effort = s.effort;
  if (process.env.SALU_CLAUDE_PATH) options.pathToClaudeCodeExecutable = process.env.SALU_CLAUDE_PATH;
  let text = '';
  let failure = '';
  for await (const m of query({ prompt: plannerPrompt(t), options: options as any })) {
    if (m.type === 'result') {
      if (m.subtype === 'success' && !m.is_error) text = m.result;
      else failure = ((m as any).result ?? (m as any).errors?.join('\n') ?? m.subtype) as string;
    }
  }
  if (!text) throw new CliError(`the planner failed: ${String(failure || 'no result').split('\n')[0]}`);
  return parsePlan(text);
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw new CliError(`${question} — pass --yes to confirm non-interactively`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((res) => rl.question(`${question} [y/N] `, res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** Split `salu`, print the sub-tickets, add them on approval and mark the original done. Returns the exit code. */
export async function planTicket(ticket: TicketView, o: { yes?: boolean } = {}): Promise<number> {
  const db = openDb();
  const fake = process.env.SALU_WORKER === 'fake';
  console.log(dim(`asking Claude to split "${ticket.name}"…`));
  const plan = fake ? fakePlan(ticket) : await askClaude(ticket);

  console.log(`\n${bold(`${plan.length} sub-tickets for "${ticket.name}"`)}`);
  plan.forEach((p, i) => {
    console.log(`\n${cyan(`${i + 1}. ${p.name}`)} ${dim(`priority ${p.priority}${p.tags ? ' · ' + p.tags : ''}`)}`);
    console.log(`   ${p.query.replace(/\s+/g, ' ').slice(0, 220)}${p.query.length > 220 ? '…' : ''}`);
  });
  console.log('');

  if (!o.yes && !fake && !(await confirm(`Add these ${plan.length} tickets to project ${ticket.project} and mark "${ticket.name}" done?`))) {
    console.log(yellow('nothing added'));
    return 1;
  }

  const created: string[] = [];
  for (const p of plan) {
    const parsed = parseTags(p.tags);
    let name = p.name;
    for (let n = 2; getTicket(db, ticket.project_id, name); n++) name = `${p.name} (${n})`;
    createTicket(db, {
      project_id: ticket.project_id,
      name,
      query: p.query,
      tags: parsed.tags,
      labels: parsed.labels,
      priority: parsed.priority ?? p.priority,
    });
    created.push(name);
  }
  updateTicket(db, ticket.id, { status: 'done', finished_at: Date.now(), error: null });
  console.log(`${green('✓')} added ${created.length} tickets; "${ticket.name}" marked done`);
  for (const n of created) console.log(dim(`  · ${n}`));
  return 0;
}
