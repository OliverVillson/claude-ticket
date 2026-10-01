import type { Ticket } from '../db/types.ts';

/** One thing a ticket produced: shown as a card in the thread view and listed by `salu show`. */
export interface TicketOutput {
  kind: 'branch' | 'pr' | 'file' | 'link';
  /** branch name, PR url, file path or url */
  ref: string;
  title?: string;
}

/**
 * Everything a ticket has produced. The thread view reads outputs only through this function.
 * Today that is the `salu/<ticket>` branch; the worker-status work adds PRs, files and links.
 */
export function ticketOutputs(t: Pick<Ticket, 'branch'>): TicketOutput[] {
  const out: TicketOutput[] = [];
  if (t.branch) out.push({ kind: 'branch', ref: t.branch });
  return out;
}
