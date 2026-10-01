import { openDb } from '../db/db.ts';
import type { Ticket } from '../db/types.ts';
import { listOutputs } from '../threads/store.ts';

/** One thing a ticket produced: shown as a card in the thread view and listed by `salu show`. */
export interface TicketOutput {
  kind: 'branch' | 'pr' | 'file' | 'link';
  /** branch name, PR url, file path or url */
  ref: string;
  title?: string;
}

/**
 * Everything a ticket has produced. The thread view reads outputs only through this function.
 * The `salu/<ticket>` branch, then what the worker attached (branch, PR, file, link) when the ticket has an id.
 */
export function ticketOutputs(t: Pick<Ticket, 'branch'> & { id?: number }): TicketOutput[] {
  const out: TicketOutput[] = [];
  if (t.branch) out.push({ kind: 'branch', ref: t.branch });
  if (t.id !== undefined) {
    try {
      for (const o of listOutputs(openDb(), t.id)) if (!out.some((x) => x.kind === o.kind && x.ref === o.ref)) out.push({ kind: o.kind, ref: o.ref, ...(o.title ? { title: o.title } : {}) });
    } catch {
      /* no database to read: the branch alone */
    }
  }
  return out;
}
