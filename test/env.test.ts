import { describe, expect, test } from 'bun:test';
import { isParentSessionVar, workerEnv } from '../src/core/env.ts';

describe('workerEnv', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/root',
    HTTPS_PROXY: 'http://proxy',
    ANTHROPIC_API_KEY: 'sk-test',
    CLAUDE_CONFIG_DIR: '/cfg',
    CLAUDE_CODE_OAUTH_TOKEN: 'tok',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_SESSION_ID: 'parent-session',
    CLAUDE_CODE_REMOTE_SESSION_ID: 'remote',
    CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
    CLAUDE_SESSION_INGRESS_TOKEN_FILE: '/tmp/tok',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    CLAUDECODE: '1',
    CLAUDE_PID: '12',
  } as NodeJS.ProcessEnv;

  test('drops parent session identity and keeps auth, provider and proxy settings', () => {
    const e = workerEnv(parent);
    for (const k of ['PATH', 'HOME', 'HTTPS_PROXY', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK']) {
      expect(e[k]).toBe(parent[k]);
    }
    for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_SESSION_INGRESS_TOKEN_FILE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE', 'CLAUDE_PID']) {
      expect(k in e).toBe(false);
    }
  });
  test('does not mutate the input and can be switched off', () => {
    const copy = { ...parent };
    workerEnv(parent);
    expect(parent).toEqual(copy);
    expect(workerEnv({ ...parent, TICKET_INHERIT_CLAUDE_ENV: '1' }).CLAUDE_CODE_SESSION_ID).toBe('parent-session');
  });
  test('only CLAUDE_* names are ever dropped', () => {
    expect(isParentSessionVar('SESSION_SECRET')).toBe(false);
    expect(isParentSessionVar('MY_REMOTE_HOST')).toBe(false);
    expect(isParentSessionVar('CLAUDE_CODE_SESSION_ID')).toBe(true);
  });
});

import { applyAuthPolicy } from '../src/core/env.ts';
describe('applyAuthPolicy', () => {
  test('warns when an API key would override the subscription', () => {
    const env = { ANTHROPIC_API_KEY: 'sk' } as NodeJS.ProcessEnv;
    expect(applyAuthPolicy(env).warning).toContain('API credits');
    expect(env.ANTHROPIC_API_KEY).toBe('sk');
  });
  test('TICKET_AUTH=subscription removes the key, api-key silences the warning', () => {
    const a = { ANTHROPIC_API_KEY: 'sk', ANTHROPIC_AUTH_TOKEN: 't', TICKET_AUTH: 'subscription' } as NodeJS.ProcessEnv;
    expect(applyAuthPolicy(a).warning).toBeNull();
    expect('ANTHROPIC_API_KEY' in a || 'ANTHROPIC_AUTH_TOKEN' in a).toBe(false);
    expect(applyAuthPolicy({ ANTHROPIC_API_KEY: 'sk', TICKET_AUTH: 'api-key' } as NodeJS.ProcessEnv).warning).toBeNull();
    expect(applyAuthPolicy({} as NodeJS.ProcessEnv).warning).toBeNull();
  });
});
