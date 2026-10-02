// Everything the Mac commands run outside salu (ssh, gh, git, claude) goes through Exec, so tests
// can replace it with a script of canned answers.
export interface ExecResult {
  ok: boolean;
  code: number;
  out: string;
  err: string;
}

export interface Exec {
  /** Run quietly and collect the output. `stdin` is written to the process (never put into argv). */
  capture(cmd: string[], o?: { stdin?: string; timeoutMs?: number; cwd?: string }): Promise<ExecResult>;
  /** Run with the terminal handed over (ssh -t, claude setup-token). Resolves with the exit code. */
  interactive(cmd: string[], o?: { cwd?: string }): Promise<number>;
}

export const realExec: Exec = {
  async capture(cmd, o = {}) {
    try {
      const proc = Bun.spawn(cmd, { stdin: o.stdin === undefined ? 'ignore' : new Blob([o.stdin]), stdout: 'pipe', stderr: 'pipe', cwd: o.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      const timer = o.timeoutMs ? setTimeout(() => proc.kill(), o.timeoutMs) : null;
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (timer) clearTimeout(timer);
      return { ok: code === 0, code, out, err };
    } catch (e) {
      // Usually "command not found": the caller words it for a person.
      return { ok: false, code: 127, out: '', err: e instanceof Error ? e.message : String(e) };
    }
  },
  async interactive(cmd, o = {}) {
    try {
      const proc = Bun.spawn(cmd, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', cwd: o.cwd });
      return await proc.exited;
    } catch {
      return 127;
    }
  },
};
