#!/usr/bin/env python3
"""Time the interactive list under a real pty.

usage: tui-perf.py [N tickets] [command ...]
  default command: bun run src/tui/bench/tui-perf-open.ts
Reports spawn -> first frame, and key -> frame latency (waits for the position counter to change).
"""
import os, pty, select, sys, time, subprocess, tempfile, statistics, struct, fcntl, termios

root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
n = int(sys.argv[1]) if len(sys.argv) > 1 else 500
cmd = sys.argv[2:] or ['bun', 'run', 'src/tui/bench/tui-perf-open.ts']
home = tempfile.mkdtemp(prefix='ticket-perf-')
env = dict(os.environ, SALU_HOME=home, FORCE_COLOR='1', TERM='xterm-256color')
subprocess.run(['bun', 'run', 'src/tui/bench/tui-perf-seed.ts', str(n)], cwd=root, env=env, check=True, stdout=subprocess.DEVNULL)

def read_until(fd, pred, timeout=5.0):
    buf = b''
    t0 = time.perf_counter()
    while time.perf_counter() - t0 < timeout:
        r, _, _ = select.select([fd], [], [], 0.001)
        if r:
            try:
                chunk = os.read(fd, 1 << 16)
            except OSError:
                break
            buf += chunk
            if pred(buf):
                return buf, time.perf_counter() - t0
    return buf, None

firsts, keys = [], []
for run in range(5):
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(root)
        os.execvpe(cmd[0], cmd, env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    t0 = time.perf_counter()
    buf, dt = read_until(fd, lambda b: '✻'.encode() in b and b'orchestrator' in b, 10)
    if dt is None:
        print('no first frame; output so far:', buf[-300:]); sys.exit(1)
    firsts.append(time.perf_counter() - t0)
    time.sleep(0.4)
    for i in range(1, 31):
        want = f'{i + 1}/{n}'.encode()
        os.write(fd, b'\x1b[B')
        _, dt = read_until(fd, lambda b, w=want: w in b, 2)
        if dt is not None:
            keys.append(dt)
        else:
            print('key', i, 'no frame')
        time.sleep(0.03)
    os.write(fd, b'q')
    time.sleep(0.2)
    try:
        os.kill(pid, 9)
    except OSError:
        pass
    os.waitpid(pid, 0)

k = sorted(keys)
print(f'{n} tickets | ' + ' '.join(cmd[-2:]))
print('  spawn -> first frame ms: ' + ' '.join(f'{x*1000:.0f}' for x in firsts) + f'   median {statistics.median(firsts)*1000:.0f}')
print(f'  key -> frame ms: median {statistics.median(k)*1000:.1f}  p95 {k[max(0,int(len(k)*0.95)-1)]*1000:.1f}  max {k[-1]*1000:.1f}  (n={len(k)})')
