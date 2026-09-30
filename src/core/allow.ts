import type { Database } from 'bun:sqlite';
import { getTicketById, queueTicket, updateTicket } from '../db/queries.ts';
import { ticketTags, type TicketView } from '../db/types.ts';
import { CliError } from './errors.ts';
import { addAllowRules, type Denial } from './tools.ts';

/** What the last run was refused, as recorded on the ticket (empty when nothing). */
export function ticketDenials(t: Pick<TicketView, 'denied'>): Denial[] {
  if (!t.denied) return [];
  try {
    const v = JSON.parse(t.denied);
    return Array.isArray(v) ? v.filter((d) => d && typeof d.rule === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The one-step remedy for a permission-blocked ticket: add the rules (the ones it was refused, or
 * the given ones) to the ticket's tools value as `also:`, clear the record, and queue it again.
 * Returns the updated ticket and the rules that were added.
 */
export function allowTicket(db: Database, id: number, rules?: string[]): { ticket: TicketView; rules: string[] } {
  const t = getTicketById(db, id);
  if (!t) throw new CliError(`no ticket with id ${id}`);
  const wanted = rules?.length ? rules : [...new Set(ticketDenials(t).map((d) => d.rule))];
  if (!wanted.length) throw new CliError(`"${t.name}" has no recorded permission denial. Name the rule: salu allow "${t.name}" --tool 'Bash(git clone *)'`);
  const tags = ticketTags(t);
  tags.tools = addAllowRules(tags.tools, wanted);
  updateTicket(db, id, { tags: JSON.stringify(tags) });
  return { ticket: queueTicket(db, id), rules: wanted };
}
