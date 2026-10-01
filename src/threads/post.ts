/**
 * Tell the clients of a box project about a worker's status, decision or output, so the laptop and
 * phone see them without a second format. Uses `postThreadMessage` from the git sync module
 * (src/sync/events.ts) when the build has it; a no-op otherwise, and on a ticket whose project is
 * not a box. Message shapes: INTERFACES.md "Git sync transport".
 */
import type { Database } from 'bun:sqlite';
import * as events from '../sync/events.ts';
import type { ChecklistItem, Decision, Output } from './store.ts';

export interface ThreadMessage {
  type: 'ticket.status' | 'ticket.decision' | 'ticket.output' | 'ticket.state';
  level: 'info' | 'success' | 'warn' | 'error';
  title: string;
  state?: string;
  checklist?: ChecklistItem[];
  decision?: { id: string; question: string; options: Array<{ label: string; consequence?: string }>; recommended?: number };
  outputs?: Array<{ kind: Output['kind']; ref: string; title?: string }>;
}

type Poster = (db: Database, ticketId: number, m: ThreadMessage) => unknown;

let override: Poster | null = null;
/** Tests replace the poster; pass null to restore. */
export function setThreadPoster(p: Poster | null): void {
  override = p;
}

export function postThread(db: Database, ticketId: number, m: ThreadMessage): void {
  try {
    const post = override ?? ((events as Record<string, unknown>).postThreadMessage as Poster | undefined);
    post?.(db, ticketId, m);
  } catch {
    /* telling the phone is best effort: a worker's tool call must not fail on it */
  }
}

export const statusMessage = (items: ChecklistItem[]): ThreadMessage => ({ type: 'ticket.status', level: 'info', title: 'Progress', checklist: items });

export const decisionMessage = (d: Decision): ThreadMessage => ({
  type: 'ticket.decision',
  level: 'warn',
  title: d.question.slice(0, 120),
  decision: { id: String(d.id), question: d.question, options: d.options.map((o) => ({ label: o.label, ...(o.consequence ? { consequence: o.consequence } : {}) })), recommended: d.recommended },
});

export const outputMessage = (o: Output): ThreadMessage => ({ type: 'ticket.output', level: 'success', title: `Attached ${o.kind}`, outputs: [{ kind: o.kind, ref: o.ref, ...(o.title ? { title: o.title } : {}) }] });
