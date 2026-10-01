import { CliError } from './errors.ts';

/**
 * Replace this process with another program (execve): same pid, same terminal, nothing left behind that still
 * holds the old environment. `spawn` and wait is not the same: the waiting parent keeps its original
 * /proc/<pid>/environ for as long as the child runs. Bun has no exec, so this calls libc's through bun:ffi.
 * Throws when that is not possible here (Windows, no libc found); the caller then decides what to do instead.
 */
export async function execReplace(argv: string[], env: Record<string, string | undefined>): Promise<never> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new CliError('exec is not available on this platform');
  const { dlopen, FFIType, ptr } = await import('bun:ffi');
  const lib = dlopen(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6', { execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } });
  const keep: Buffer[] = [];
  const cstr = (s: string) => {
    const b = Buffer.from(s + '\0');
    keep.push(b);
    return ptr(b);
  };
  const vec = (items: string[]) => {
    const a = new BigUint64Array(items.length + 1);
    items.forEach((s, i) => (a[i] = BigInt(cstr(s))));
    return a;
  };
  const exe = cstr(argv[0]!);
  const args = vec(argv);
  const envp = vec(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined).map(([k, v]) => `${k}=${v}`));
  lib.symbols.execve(exe, ptr(args), ptr(envp)); // only returns on failure
  throw new CliError(`could not restart salu with a clean environment (execve failed)`);
}
