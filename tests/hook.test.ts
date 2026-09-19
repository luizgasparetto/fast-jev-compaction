import { describe, expect, it } from 'vitest';
import {
  compactSession,
  decisionLog,
  decisionLogLines,
  envOptions,
  register,
  resolveHookConfig,
  summarize,
  toSessionMessages,
} from '../hooks/fast-jev.ts';
import { applyDecisions, collectToolCalls, decideCall, type Message } from '../src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    call('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
    result('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

function jevFetch(answer: (name: string) => number, bodies: string[] = []) {
  return async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? '');
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({ compactAtPercent: 60, minReductionRatio: 0.25, model: 'jev-latest' });
    expect(
      resolveHookConfig({ apiKey: 'k', keepThreshold: 0.3, maxStateTokens: 1000, model: 'jev-x', goal: 'g', compactAtPercent: 'no' }),
    ).toEqual({
      apiKey: 'k',
      keepThreshold: 0.3,
      maxStateTokens: 1000,
      model: 'jev-x',
      goal: 'g',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
    });
  });
});

describe('env options', () => {
  it('maps FAST_JEV_* variables onto plugin options, numbers parsed', async () => {
    const env: Record<string, string> = { FAST_JEV_KEEP_THRESHOLD: '0.7', FAST_JEV_MODEL: 'jev-x', FAST_JEV_MAX_STATE_TOKENS: 'nope' };
    const options = await envOptions({ env: { get: async (name) => env[name] } });
    expect(options).toEqual({ keepThreshold: 0.7, model: 'jev-x', maxStateTokens: NaN });
    expect(resolveHookConfig(options)).toMatchObject({ keepThreshold: 0.7, model: 'jev-x' });
    expect(resolveHookConfig(options)).not.toHaveProperty('maxStateTokens');
  });
});

describe('register', () => {
  function engine(fetchFn: ReturnType<typeof jevFetch>, percent: number, tokens?: number) {
    const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    const logs: string[] = [];
    const store: Record<string, unknown> = {};
    const commands: string[] = [];
    const $ = {
      env: { get: async () => undefined },
      settings: { read: async () => ({}) },
      http: { fetch: fetchFn },
      ui: { log: (t: string) => logs.push(t), toast: () => {} },
      store: { get: async (k: string) => store[k], set: async (k: string, v: unknown) => { store[k] = v; } },
      command: { register: async (spec: { name: string }) => { commands.push(spec.name); } },
      session: {
        usage: async () => ({ context: { percent, tokens } }),
        compact: () => handlers['session.compact']!($, { trigger: 'plugin', messages: transcript() }, async () => ({ messages: [] })),
      },
    };
    const on = (name: string, a: unknown, b?: unknown) => { handlers[name] = (b ?? a) as (...args: unknown[]) => Promise<unknown>; };
    register(on as never, { apiKey: 'k', preserveRecentMessages: 1 });
    const compact = (trigger: string) => handlers['session.compact']!($, { trigger, messages: transcript() }, async () => 'built-in');
    const turn = () => handlers['turn.complete']!($, {}, async () => 'next');
    // Drains the turn.step generator over a one-chunk stream, as the engine would.
    const step = async () => {
      const stream = (handlers['turn.step'] as (...args: unknown[]) => AsyncGenerator<unknown, unknown>)(
        $, { turnId: 't', index: 0 }, () => (async function* () { yield 'chunk'; return 'response'; })(),
      );
      let last = await stream.next();
      while (!last.done) last = await stream.next();
      return last.value;
    };
    const command = () => handlers['command.run']!($, { command: 'fast-jev', args: '' }, async () => 'built-in') as Promise<{ text: string }>;
    return { compact, turn, step, command, logs, store, commands, setTokens: (t: number) => { tokens = t; } };
  }

  it('skips instead of summarizing when it triggered the compaction itself', async () => {
    const { compact, logs } = engine(async () => ({ status: 500, ok: false, text: 'down' }), 0);
    expect(await compact('plugin')).toMatchObject({ skip: /Jev request failed \(500\)/ });
    expect(await compact('auto')).toBe('built-in');
    expect(logs.filter((l) => l.startsWith('skipped ('))).toHaveLength(1);
  });

  it('backs off after a skipped auto-compaction until the context grows', async () => {
    const { turn, logs } = engine(async () => ({ status: 500, ok: false, text: 'down' }), 60);
    await turn();
    await turn();
    expect(logs.filter((l) => l.startsWith('skipped ('))).toHaveLength(1);
  });

  it('measures the context before and after a compaction and serves /fast-jev', async () => {
    const { compact, turn, step, command, store, commands, setTokens } = engine(jevFetch(() => 0.1), 10, 120_000);
    await turn();
    expect(commands).toEqual(['fast-jev']);
    expect((await command()).text).toBe('this session: no Jev compaction yet' + '\n' + 'all time: no Jev compaction yet');
    expect(await step()).toBe('response');
    expect(store['savings']).toBeUndefined();
    expect(await compact('auto')).toHaveProperty('messages');
    setTokens(30_000);
    expect(await step()).toBe('response');
    expect(store['savings']).toEqual({ compactions: 1, tokensBefore: 120_000, tokensAfter: 30_000 });
    expect((await command()).text).toContain('this session: 1 compaction(s), context 120k → 30k tokens (−90k, 75%); 1 summary call(s) avoided (~120k input tokens)');
    await step();
    expect((store['savings'] as { compactions: number }).compactions).toBe(1);
  });
});

describe('session message mapping', () => {
  it('returns the engine objects for untouched messages and handle-less copies for rebuilt ones', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    messages[1]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[2]!.toolResults![0]!.text = 'x'.repeat(2000);
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out).toHaveLength(messages.length);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]?.handle).toBeUndefined();
    expect(out[1]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'tool-1', isError: false });
    expect(out[3]).toBe(messages[3]);
    expect(out[4]).toBe(messages[4]);
  });

  it('preserves short dropped-result messages and their handles', () => {
    const messages = transcript();
    messages[1]!.toolUses[0]!.text = 'y'.repeat(100);
    messages[2]!.toolResults![0]!.text = 'y'.repeat(100);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).toBe(messages[2]);
  });
});

describe('compactSession', () => {
  it('runs the library over the engine fetch and reports the outcome', async () => {
    const bodies: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1, targetReduction: 0 }), apiKey: 'k', model: 'jev-x' };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), bodies),
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).model).toBe('jev-x');
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_call', 'keep']);
    expect(messages.map((m) => m.handle)).toEqual(['h-0', 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
    expect(summarize(output)).toMatch(/^\d+% reduction; 1 kept, 1 call_dropped; state ~\d+ tokens \(full\) in 1 request\(s\)$/);
    expect(decisionLog(output)).toBe('t1:Read:drop_call/call=0.10/result=0.10 t2:Bash:keep/call=0.90/result=0.90');
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1, targetReduction: 0 }), apiKey: 'k' };
    const { result: output } = await compactSession(transcript(), config, jevFetch(() => 0.1));
    const lines = decisionLogLines(output, 60);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:drop_call/call=0.10/result=0.10',
      'decisions (2/2): t2:Bash:drop_call/call=0.10/result=0.10',
    ]);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('throws on a missing key and on failed requests so the hook falls back', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    await expect(compactSession(transcript(), config, jevFetch(() => 0))).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactSession(transcript(), { ...config, apiKey: 'k' }, async () => ({ status: 500, ok: false, text: 'x' })),
    ).rejects.toThrow(/500/);
  });
});
