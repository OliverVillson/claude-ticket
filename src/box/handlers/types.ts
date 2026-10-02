/**
 * What the control watcher (src/control/watcher.ts) calls. The shapes are the contract's (docs/control-channel.md):
 * `Handlers` maps every verb to a function of its validated args and a way to open its sealed fields.
 */
export type Verb = 'ping' | 'status' | 'login.set' | 'project.create' | 'project.remove' | 'update';
export interface HandlerResult {
  ok: boolean;
  /** one line for a person; on failure it says what to do next, in plain words */
  message: string;
  data?: unknown;
}
export type Handler = (a: { args: any; secret(field: string): Buffer }) => Promise<HandlerResult>;
export type Handlers = Record<Verb, Handler>;

export interface RunResult {
  ok: boolean;
  out: string;
}
export interface BoxDeps {
  /** Run a program (no shell). `as`: run it as this Linux user; `input` goes to stdin; `env` is added to the environment. */
  run(cmd: string[], o?: { input?: string; as?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<RunResult>;
  /** The salu binary to run for salu commands (the installed one, so an update is picked up by the next command). */
  salu: string;
  /** The Linux user that owns the runner folder and runs podman (default `salu`). */
  user: string;
  version: string;
  /** Where temporary files with secrets go (private, removed after use). */
  tmpDir: string;
  now(): number;
}
