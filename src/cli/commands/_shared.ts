import { createInterface } from 'node:readline';
import type { Parsed } from '../args.ts';
import { flagBool } from '../args.ts';
import { CliError } from '../../core/errors.ts';

/** Ask a yes/no question on the terminal. Non-interactive stdin without --yes is an error. */
export async function confirm(p: Parsed, question: string): Promise<boolean> {
  if (flagBool(p, 'yes')) return true;
  if (!process.stdin.isTTY) throw new CliError(`${question} — pass --yes to confirm non-interactively`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((res) => rl.question(`${question} [y/N] `, res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export function helpIf(p: Parsed, text: string): boolean {
  if (flagBool(p, 'help')) {
    console.log(text);
    return true;
  }
  return false;
}

export function isTTY(): boolean {
  return !!process.stdout.isTTY && !!process.stdin.isTTY && !process.env.TICKET_NO_TUI;
}
