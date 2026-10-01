/** Answering a decision, the same way from the CLI and the TUI. */
import type { Database } from 'bun:sqlite';
import { CliError } from '../core/errors.ts';
import { replyToTicket } from '../db/queries.ts';
import type { TicketView } from '../db/types.ts';
import { answerDecision, getDecision, listDecisions, type Decision } from './store.ts';

/**
 * Pick option `index` (0-based) on a decision. The worker already carried on with the recommended
 * option, so picking that one only records it. Any other pick tells the worker (a user turn), and a
 * finished ticket goes back in the queue like with any reply.
 */
export function answerAndNotify(db: Database, ticketId: number, decisionId: number, index: number, o: { now?: boolean } = {}): { decision: Decision; ticket: TicketView | null } {
  const d = getDecision(db, decisionId);
  if (!d || d.ticket_id !== ticketId) throw new CliError(`no decision #${decisionId} on this thread`);
  if (!Number.isInteger(index) || index < 0 || index >= d.options.length) throw new CliError(`pick a number from 1 to ${d.options.length}`);
  const decision = answerDecision(db, d.id, { chosen: index });
  if (index === d.recommended) return { decision, ticket: null };
  const pick = d.options[index]!;
  const ticket = replyToTicket(db, ticketId, `Decision on "${d.question}": the human chose "${pick.label}" (${pick.consequence}), not "${d.options[d.recommended]!.label}". Change course to match.`, { now: o.now });
  return { decision, ticket };
}

/** Typed words answer every open decision on the ticket: the worker gets the message and sees them in it. */
export function answerOpenWithText(db: Database, ticketId: number, text: string): number {
  const open = listDecisions(db, ticketId, { open: true });
  for (const d of open) answerDecision(db, d.id, { text });
  return open.length;
}
