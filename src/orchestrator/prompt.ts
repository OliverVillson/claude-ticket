import type { TicketView } from '../db/types.ts';
import { ticketLabels } from '../db/types.ts';

/**
 * The trailer a worker must end with. Matched against the last lines of the final message, so a
 * worker that adds a sentence after it, or wraps it in markdown emphasis, is still understood.
 */
export const TRAILER_RE = /^\s*(?:[*_`]+)?TICKET:(?:[*_`]+)?\s*(done|blocked|failed)\b[\s:,.\-–—]*(.*?)\s*(?:[*_`]+)?$/i;

export type TrailerKind = 'done' | 'blocked' | 'failed';

export interface Trailer {
  kind: TrailerKind;
  message: string;
}

/** Find the `TICKET:` trailer in a worker's final text, scanning from the end (last match wins). */
export function parseTrailer(text: string | null | undefined): Trailer | null {
  if (!text) return null;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = TRAILER_RE.exec(lines[i]!);
    if (m) return { kind: m[1]!.toLowerCase() as TrailerKind, message: (m[2] ?? '').trim() };
  }
  return null;
}

/** Folder- and branch-safe form of a ticket name. */
export function ticketSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'ticket'
  );
}

/** The user prompt for a fresh run: one line naming the ticket and project, then the query. */
export function buildPrompt(t: TicketView): string {
  const labels = ticketLabels(t);
  const head = `Ticket "${t.name}" (#${t.id}) in project "${t.project}"${labels.length ? ` [${labels.join(', ')}]` : ''}`;
  return `${head}\n\n${t.query.trim()}\n\nWhen finished, end your final message with the TICKET: trailer described in your instructions.`;
}

/** The user prompt when resuming a saved session that was interrupted (limit, restart, out of turns). */
export function buildResumePrompt(t: TicketView, why: string): string {
  return [
    `Continue ticket "${t.name}" (#${t.id}) in project "${t.project}". The previous session was interrupted (${why}).`,
    'Check the current state of the files first, since some of your earlier changes may already be on disk, then pick up where you left off and finish.',
    'The ticket text, in case it changed since you started:',
    '',
    t.query.trim(),
    '',
    'End your final message with the TICKET: trailer.',
  ].join('\n');
}

/** The prompt for a follow-up: the worker already has the ticket and its own earlier work in its session. */
export function buildFollowUpPrompt(t: TicketView, messages: string[]): string {
  return [
    `Follow-up on ticket "${t.name}" (#${t.id}) in project "${t.project}". ${messages.length > 1 ? 'The human sent these messages since your last reply:' : 'The human wrote:'}`,
    '',
    ...messages.flatMap((m) => [m.trim(), '']),
    'Check the current state of the files first if it matters, then do what they ask. Keep committing on the same salu/ branch.',
    'End your final message with the TICKET: trailer.',
  ].join('\n');
}

/** A follow-up when the old session is gone: the ticket, the conversation so far, then the new message. */
export function buildFollowUpFreshPrompt(t: TicketView, history: Array<{ role: 'user' | 'assistant'; body: string }>, messages: string[]): string {
  return [
    buildPrompt(t),
    '',
    'This ticket already has a conversation; your earlier session is not available, so here it is:',
    ...history.flatMap((h) => ['', `${h.role === 'user' ? 'Human' : 'You'}: ${h.body.trim()}`]),
    '',
    `The human now writes:`,
    ...messages.map((m) => m.trim()),
  ].join('\n');
}

/** Appended to Claude Code's own system prompt for every worker. */
export function systemAppend(t: TicketView): string {
  return [
    `You are a worker agent run unattended by the \`salu\` queue, working on ticket "${t.name}" of project "${t.project}". Nobody is watching and nobody can answer a question during the run.`,
    `Working directory: ${t.project_path}. Work only inside this project folder unless the ticket explicitly says otherwise.`,
    '',
    'Rules:',
    '- Do what the ticket asks, verify it (run the relevant tests or checks when the project has them), then stop.',
    '- Never ask for clarification or permission mid-way. When something is ambiguous, pick the reasonable default and name it in your final message.',
    `- If the work changes files in a git repository, commit on a branch named \`salu/${ticketSlug(t.name)}\` (create it from the current branch if needed) and never push.`,
    '- If a tool call is denied and there is no other way, or the ticket needs a decision only a human can make, stop and report it as blocked with a one-line question.',
    '- Do not publish, deploy, send messages, or touch anything outside the project folder unless the ticket explicitly asks for it.',
    '- Keep your final message short: what you did, what you verified, anything left undone.',
    '',
    'Your final message MUST end with exactly one trailer line, nothing after it:',
    '  TICKET: done',
    '  TICKET: blocked <one-line question for the human>',
    '  TICKET: failed <one-line reason it cannot be done>',
  ].join('\n');
}
