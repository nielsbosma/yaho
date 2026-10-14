import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vite-plus/test';
import { agentEnv, jobEnv } from './asAgent.ts';
import { transcriptWriter } from './claudeCode.ts';
import type { HarnessEvent } from './types.ts';

const dir = mkdtempSync(join(tmpdir(), 'yaho-harness-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the environment of agent processes', () => {
  const core = {
    PATH: '/usr/bin',
    HOME: '/home/core',
    LANG: 'C.UTF-8',
    HTTPS_PROXY: 'http://proxy',
    YAHO_PASSWORD: 'hunter2',
    YAHO_TOTP_SECRET: 'x',
    YAHO_AGENT_HOME: '/data/home',
    ANTHROPIC_API_KEY: 'sk-ant',
    OPENAI_API_KEY: 'sk-oai',
    PROVIDER_LITELLM_MASTER_KEY: 'sk-master',
    CLAUDECODE: '1',
    MY_TOOL_SETTING: 'on',
  };

  it('passes only what programs need to processes started as the agent', () => {
    expect(agentEnv(core)).toEqual({ PATH: '/usr/bin', HOME: '/home/core', LANG: 'C.UTF-8', HTTPS_PROXY: 'http://proxy', YAHO_AGENT_HOME: '/data/home' });
  });

  it("keeps the person's own variables for desktop jobs, never credentials or Yaho's own", () => {
    const uid = process.env.YAHO_AGENT_UID;
    delete process.env.YAHO_AGENT_UID;
    try {
      const env = jobEnv(core);
      expect(env.MY_TOOL_SETTING).toBe('on');
      for (const k of ['YAHO_PASSWORD', 'YAHO_TOTP_SECRET', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDECODE']) expect(env[k]).toBeUndefined();
      if (process.platform !== 'win32') {
        process.env.YAHO_AGENT_UID = '1001';
        expect(jobEnv(core)).toEqual(agentEnv(core));
      }
    } finally {
      if (uid === undefined) delete process.env.YAHO_AGENT_UID;
      else process.env.YAHO_AGENT_UID = uid;
    }
  });
});

describe.skipIf(process.platform === 'win32')('transcripts', () => {
  it('appends in the workspace and never through a link the agent put there', () => {
    const ws = join(dir, 'ws');
    mkdirSync(join(ws, '.yaho'), { recursive: true });
    const events: HarnessEvent[] = [];
    const write = transcriptWriter({ cwd: ws, transcriptPath: join(ws, '.yaho', 's.jsonl') } as never, (e) => events.push(e));
    write('{"a":1}');
    write('{"a":2}');
    expect(readFileSync(join(ws, '.yaho', 's.jsonl'), 'utf8')).toBe('{"a":1}\n{"a":2}\n');

    const db = join(dir, 'yaho.db');
    writeFileSync(db, 'database');
    symlinkSync(db, join(ws, '.yaho', 'evil.jsonl'));
    const evil = transcriptWriter({ cwd: ws, transcriptPath: join(ws, '.yaho', 'evil.jsonl') } as never, (e) => events.push(e));
    evil('{"b":1}');
    evil('{"b":2}');
    expect(readFileSync(db, 'utf8')).toBe('database');
    expect(events.filter((e) => e.kind === 'stderr')).toHaveLength(1);
  });
});
