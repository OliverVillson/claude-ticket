#!/usr/bin/env bun
// Entry point. Keeps startup light: the TUI (Ink/React) and the orchestrator (Agent SDK)
// are imported lazily, so `add`, `remove`, `change`, `status` never load them.
import './core/compat.ts';
import { dispatch } from './cli/dispatch.ts';
import { CliError } from './core/errors.ts';
import { red } from './core/ansi.ts';

dispatch(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    if (err instanceof CliError) {
      console.error(red('error: ') + err.message);
      process.exit(err.exitCode);
    }
    console.error(err);
    process.exit(1);
  },
);
