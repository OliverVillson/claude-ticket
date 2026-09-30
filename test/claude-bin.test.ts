import { describe, expect, test } from 'bun:test';
import { CLAUDE_MISSING, checkClaude, claudeExecutableOption, environmentProblem, findClaude, loginProblem, preflightClaude } from '../src/core/claude-bin.ts';

const exec = (...paths: string[]) => (p: string) => paths.includes(p);
const base = { HOME: '/home/u', PATH: '/usr/bin:/opt/bin' } as NodeJS.ProcessEnv;

describe('findClaude', () => {
  test('SALU_CLAUDE_PATH wins, and a wrong one is not silently replaced', () => {
    const env = { ...base, SALU_CLAUDE_PATH: '/x/claude' };
    expect(findClaude({ env, isExecutable: exec('/x/claude', '/opt/bin/claude') })).toEqual({ path: '/x/claude', source: 'SALU_CLAUDE_PATH' });
    expect(findClaude({ env, isExecutable: exec('/opt/bin/claude') })).toBeNull();
    expect(checkClaude({ env, isExecutable: exec('/opt/bin/claude') }).problem).toContain('SALU_CLAUDE_PATH points to /x/claude');
  });
  test('PATH first, then the usual install folders in order', () => {
    expect(findClaude({ env: base, isExecutable: exec('/opt/bin/claude', '/home/u/.local/bin/claude') })).toEqual({ path: '/opt/bin/claude', source: 'PATH' });
    expect(findClaude({ env: base, isExecutable: exec('/home/u/.local/bin/claude', '/opt/homebrew/bin/claude') })?.path).toBe('/home/u/.local/bin/claude');
    expect(findClaude({ env: base, isExecutable: exec('/opt/homebrew/bin/claude') })?.path).toBe('/opt/homebrew/bin/claude');
    expect(findClaude({ env: base, isExecutable: exec('/home/u/.claude/local/claude', '/usr/local/bin/claude') })?.path).toBe('/home/u/.claude/local/claude');
  });
  test('nvm: the newest node version wins', () => {
    const listDir = (p: string) => (p.endsWith('.nvm/versions/node') ? ['v18.0.0', 'v22.1.0'] : []);
    const r = findClaude({ env: base, listDir, isExecutable: exec('/home/u/.nvm/versions/node/v18.0.0/bin/claude', '/home/u/.nvm/versions/node/v22.1.0/bin/claude') });
    expect(r?.path).toBe('/home/u/.nvm/versions/node/v22.1.0/bin/claude');
  });
  test('nothing found gives the install message', () => {
    expect(findClaude({ env: base, isExecutable: () => false })).toBeNull();
    const c = checkClaude({ env: base, isExecutable: () => false });
    expect(c.ok).toBe(false);
    expect(c.problem).toBe(CLAUDE_MISSING);
    expect(c.problem).toContain('claude.ai/install.sh');
    expect(c.problem).toContain('SALU_CLAUDE_PATH');
  });
});

describe('what the SDK is told', () => {
  test('the compiled binary passes the installed claude; source leaves the SDK its own', () => {
    const isExecutable = exec('/opt/bin/claude');
    expect(claudeExecutableOption({ env: base, isExecutable, compiled: true })).toBe('/opt/bin/claude');
    expect(claudeExecutableOption({ env: base, isExecutable, compiled: false })).toBeUndefined();
    expect(claudeExecutableOption({ env: { ...base, SALU_CLAUDE_PATH: '/y/claude' }, isExecutable, compiled: false })).toBe('/y/claude');
    expect(claudeExecutableOption({ env: base, isExecutable: () => false, compiled: true })).toBeUndefined();
  });
  test('preflight only applies where salu has no claude of its own', () => {
    expect(preflightClaude({ env: base, isExecutable: () => false, compiled: true })).toBe(CLAUDE_MISSING);
    expect(preflightClaude({ env: base, isExecutable: exec('/opt/bin/claude'), compiled: true })).toBeNull();
    expect(preflightClaude({ env: base, isExecutable: () => false, compiled: false })).toBeNull();
    expect(preflightClaude({ env: { ...base, SALU_CLAUDE_PATH: '/nope' }, isExecutable: () => false, compiled: false })).toContain('/nope');
    expect(preflightClaude({ env: { ...base, SALU_WORKER: 'fake' }, isExecutable: () => false, compiled: true })).toBeNull();
  });
});

describe('environmentProblem', () => {
  test('recognises the SDK error from the released binary and login problems', () => {
    const sdk = 'Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.';
    expect(environmentProblem(sdk)).toBe(CLAUDE_MISSING);
    expect(environmentProblem('spawn /x/claude ENOENT')).toBe(CLAUDE_MISSING);
    expect(environmentProblem('Invalid API key · Please run /login')).toContain('login expired');
    expect(environmentProblem('the tests failed')).toBeNull();
    expect(environmentProblem(null)).toBeNull();
  });
});

describe('login detection', () => {
  test.each([
    'Failed to authenticate: OAuth session expired and could not be refreshed',
    'Invalid API key · Please run /login',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
    'Credit balance is too low',
  ])('%s is an environment problem', (t) => {
    expect(environmentProblem(t)).toContain('/login');
  });
  test('ordinary failures are not', () => {
    expect(environmentProblem('the tests failed: 401 cases passed')).toBeNull();
    expect(environmentProblem('ran out of turns')).toBeNull();
  });
  test('loginProblem reads auth status', async () => {
    const say = (out: string, ok = true) => async () => ({ ok, out });
    expect(await loginProblem('/x/claude', say('{"loggedIn": false}'))).toContain('/login');
    expect(await loginProblem('/x/claude', say('{"loggedIn": true, "email": "a@b"}'))).toBeNull();
    expect(await loginProblem('/x/claude', say('', false))).toBeNull(); // unclear is not a problem
  });
});
