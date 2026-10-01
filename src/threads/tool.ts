/**
 * The `salu` tool a worker gets in-process: post a checklist, ask a decision, attach an output,
 * start a sub-thread. Every tool is `{ name, description, shape, handler }` in `TOOLS`; the handler
 * is plain (db and ticket in, text out) so the real MCP server, the fake runner and the tests all
 * share it. Contract: /mnt/project-files/salu-threads/worker-tool.md
 */
import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { safeText } from '../core/ansi.ts';
import { EFFORTS, validateEffort, validateModel } from '../core/tags.ts';
import { createTicket, getTicketById, queueTicket } from '../db/queries.ts';
import { ticketTags } from '../db/types.ts';
import type { TicketView } from '../db/types.ts';
import { ticketSlug } from '../orchestrator/prompt.ts';
import { OUTPUT_KINDS, addDecision, addOutput, listChildren, setChecklist, threadDepth } from './store.ts';

export const MCP_NAME = 'salu';
export const MAX_DEPTH = 3;
export const MAX_CHILDREN = 8;

export interface ToolContext {
  db: Database;
  ticket: TicketView;
}

export interface ToolResult {
  text: string;
  error?: boolean;
}

const ok = (text: string): ToolResult => ({ text });
const fail = (text: string): ToolResult => ({ text, error: true });
const clip = (s: string, n: number) => safeText(s).trim().slice(0, n);

export interface SaluTool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  shape: S;
  handler: (ctx: ToolContext, args: z.infer<z.ZodObject<S>>) => ToolResult;
}

function define<S extends z.ZodRawShape>(t: SaluTool<S>): SaluTool<S> {
  return t;
}

const status = define({
  name: 'status',
  description: 'Post your progress checklist (replaces the whole list). Call it when you start and whenever a step changes. 1 to 12 short items, each todo, doing or done.',
  shape: { items: z.array(z.object({ text: z.string().max(200), state: z.enum(['todo', 'doing', 'done']) })).min(1).max(12) },
  handler: ({ db, ticket }, { items }) => {
    setChecklist(db, ticket.id, items.map((i) => ({ text: clip(i.text, 80), state: i.state })));
    return ok('ok');
  },
});

const askDecision = define({
  name: 'ask_decision',
  description: 'Ask the human a question with 2 to 4 options and say which you recommend. It does not wait: carry on with the recommended option; if the human picks another one later you are told. Use it instead of stopping when the work can go on with a sensible default.',
  shape: {
    question: z.string().max(600),
    options: z.array(z.object({ label: z.string().max(80), consequence: z.string().max(400) })).min(2).max(4),
    recommended: z.number().int().min(0).describe('0-based index of the recommended option'),
    context: z.string().max(2400).optional(),
  },
  handler: ({ db, ticket }, a) => {
    if (a.recommended >= a.options.length) return fail(`recommended must be between 0 and ${a.options.length - 1}`);
    const options = a.options.map((o) => ({ label: clip(o.label, 40), consequence: clip(o.consequence, 200) }));
    const d = addDecision(db, ticket.id, { question: clip(a.question, 300), context: clip(a.context ?? '', 1200), options, recommended: a.recommended });
    return ok(`Recorded as decision #${d.id}. Carry on with the recommended option (${options[a.recommended]!.label}) unless a later message says otherwise.`);
  },
});

const attach = define({
  name: 'attach',
  description: 'Attach an output to the thread: a branch name, a pull request URL, a file path inside the project, or a link. Shown as a card; attaching the same thing again just updates its title.',
  shape: { kind: z.enum(['branch', 'pr', 'file', 'link']), ref: z.string().max(500), title: z.string().max(200).optional() },
  handler: ({ db, ticket }, a) => {
    const ref = clip(a.ref, 500);
    if (!ref) return fail('ref is empty');
    if (!OUTPUT_KINDS.includes(a.kind)) return fail(`kind must be one of ${OUTPUT_KINDS.join(', ')}`);
    if ((a.kind === 'pr' || a.kind === 'link') && !/^https?:\/\//i.test(ref)) return fail(`a ${a.kind} needs an http(s) URL`);
    addOutput(db, ticket.id, { kind: a.kind, ref, title: clip(a.title ?? '', 120) });
    return ok('attached');
  },
});

const startThread = define({
  name: 'start_thread',
  description: 'Start a sub-thread: a new ticket in this project, queued, linked to this one. It runs on its own with the same permissions and tools as you; you may only choose its model and effort. Give it a complete prompt, it has not seen this conversation.',
  shape: { name: z.string().max(200), prompt: z.string().max(20000), model: z.string().max(80).optional(), effort: z.enum(EFFORTS).optional() },
  handler: ({ db, ticket }, a) => {
    const prompt = a.prompt.trim();
    if (!prompt) return fail('prompt is empty');
    if (threadDepth(db, ticket.id) + 1 >= MAX_DEPTH) return fail(`sub-threads can go ${MAX_DEPTH} levels deep at most; do this one yourself`);
    if (listChildren(db, ticket.id).length >= MAX_CHILDREN) return fail(`this thread already started ${MAX_CHILDREN} sub-threads; do the rest yourself`);
    const tags = { ...ticketTags(ticket) };
    try {
      if (a.model) tags.model = validateModel(a.model);
      if (a.effort) tags.effort = validateEffort(a.effort);
    } catch (e: any) {
      return fail(String(e?.message ?? e));
    }
    const base = ticketSlug(a.name);
    let name = base;
    for (let n = 2; n < 100; n++) {
      try {
        const child = createTicket(db, { project_id: ticket.project_id, name, query: prompt, tags, priority: ticket.priority, status: 'backlog' });
        db.run('UPDATE tickets SET parent_id = ? WHERE id = ?', [ticket.id, child.id]);
        queueTicket(db, child.id);
        return ok(`Started sub-thread "${child.name}" (#${child.id}).`);
      } catch (e: any) {
        if (!/already exists/.test(String(e?.message))) return fail(String(e?.message ?? e));
        name = `${base}-${n}`;
      }
    }
    return fail('could not find a free name');
  },
});

export const TOOLS: SaluTool<any>[] = [status, askDecision, attach, startThread];

/** Run a tool by name, for the fake runner and tests. Never throws. */
export function callTool(ctx: ToolContext, name: string, args: unknown): ToolResult {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return fail(`no tool named ${name}`);
  const parsed = z.object(tool.shape).safeParse(args);
  if (!parsed.success) return fail(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  try {
    return tool.handler(ctx, parsed.data);
  } catch (e: any) {
    return fail(String(e?.message ?? e));
  }
}

/** Names the SDK sees: `mcp__salu__status` ... */
export const TOOL_NAMES = TOOLS.map((t) => `mcp__${MCP_NAME}__${t.name}`);

/** The in-process MCP server config for one worker session. Loads the SDK lazily, like the runner does. */
export async function saluMcpServer(db: Database, ticket: TicketView) {
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  return createSdkMcpServer({
    name: MCP_NAME,
    tools: TOOLS.map((t) =>
      tool(t.name, t.description, t.shape, async (args) => {
        // Read the ticket again: it may have changed (a new parent link, tags) since the session started.
        const r = callTool({ db, ticket: getTicketById(db, ticket.id) ?? ticket }, t.name, args);
        return { content: [{ type: 'text' as const, text: r.text }], ...(r.error ? { isError: true } : {}) };
      }),
    ),
  });
}

/** The paragraph added to the worker's system prompt. */
export const TOOL_PROMPT = [
  'You also have a `salu` tool set (mcp__salu__*) that talks to the human:',
  '- `status`: post a short progress checklist at the start and update it as steps finish.',
  '- `ask_decision`: when a choice is the human\'s to make but the work can go on, ask it with options and a recommendation, then continue on the recommendation. Prefer this to ending with `TICKET: blocked`; use blocked only when you cannot do anything useful without the answer.',
  '- `attach`: attach the branch, pull request, files or links you produced.',
  '- `start_thread`: hand a self-contained piece of work to a sub-thread (give it a complete prompt).',
].join('\n');
