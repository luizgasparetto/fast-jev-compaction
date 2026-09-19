import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

type Env = { env: { get: (name: string) => Promise<string | undefined> } };

/** Plugin options from `FAST_JEV_*` variables, numbers parsed; unset ones are left out. */
export async function envOptions($: Env): Promise<PluginOptions> {
  const raw: Record<string, string | undefined> = {
    keepThreshold: await $.env.get('FAST_JEV_KEEP_THRESHOLD'),
    preserveRecentMessages: await $.env.get('FAST_JEV_PRESERVE_RECENT_MESSAGES'),
    compactAtPercent: await $.env.get('FAST_JEV_COMPACT_AT_PERCENT'),
    minReductionRatio: await $.env.get('FAST_JEV_MIN_REDUCTION_RATIO'),
    maxStateTokens: await $.env.get('FAST_JEV_MAX_STATE_TOKENS'),
    maxRequestTokens: await $.env.get('FAST_JEV_MAX_REQUEST_TOKENS'),
    truncateHeadChars: await $.env.get('FAST_JEV_TRUNCATE_HEAD_CHARS'),
    targetReduction: await $.env.get('FAST_JEV_TARGET_REDUCTION'),
    model: await $.env.get('FAST_JEV_MODEL'),
    goal: await $.env.get('FAST_JEV_GOAL'),
  };
  const options: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value) options[key] = key === 'model' || key === 'goal' ? value : Number(value);
  }
  return options;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
    'targetReduction',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(fetchFn: HookFetch, apiKey: string, model: string): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const result = await compact(messages, jevAsker(fetchFn, config.apiKey, config.model), config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

/** The plugin options over the `FAST_JEV_*` environment. */
async function configure($: Env, options: PluginOptions): Promise<HookConfig> {
  return resolveHookConfig({ ...(await envOptions($)), ...options });
}

/** Tokens saved: contexts measured before and after each compaction that replaced the summary. */
export type Savings = { compactions: number; tokensBefore: number; tokensAfter: number };

const NO_SAVINGS: Savings = { compactions: 0, tokensBefore: 0, tokensAfter: 0 };

function add(savings: Savings, before: number, after: number): Savings {
  return {
    compactions: savings.compactions + 1,
    tokensBefore: savings.tokensBefore + before,
    tokensAfter: savings.tokensAfter + after,
  };
}

function k(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

export function savingsLine(label: string, s: Savings): string {
  if (s.compactions === 0) return `${label}: no Jev compaction yet`;
  const saved = s.tokensBefore - s.tokensAfter;
  return `${label}: ${s.compactions} compaction(s), context ${k(s.tokensBefore)} → ${k(s.tokensAfter)} tokens (−${k(saved)}, ${Math.round((saved / s.tokensBefore) * 100)}%); ${s.compactions} summary call(s) avoided (~${k(s.tokensBefore)} input tokens)`;
}

type Store = { store: { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void> } };

async function allTimeSavings($: Store): Promise<Savings> {
  return { ...NO_SAVINGS, ...((await $.store.get('savings')) as Partial<Savings> | undefined) };
}

async function contextTokens($: { session: { usage: () => Promise<{ context: { tokens?: number; percent?: number } }> } }) {
  return (await $.session.usage()).context;
}

type Commands = { command: { register: (spec: { name: string; description: string }) => Promise<unknown> } };

async function registerCommand($: Commands): Promise<void> {
  await $.command.register({
    name: 'fast-jev',
    description: 'Tokens saved by Jev compaction, this session and all time.',
  });
}

export const register: Register = (on: On, options: PluginOptions) => {
  let compacting = false;
  let retryAtPercent = 0;
  let session: Savings = { ...NO_SAVINGS };
  // The context measured before a compaction; its "after" is the next request's input.
  let pending: number | undefined;
  // Registered on session.start, or on the first turn when the plugin was loaded mid-session.
  let commandRegistered = false;

  on('session.start', async ($, event, next) => {
    if (!commandRegistered) {
      commandRegistered = true;
      await registerCommand($);
    }
    return next(event);
  });

  on('command.run', { command: 'fast-jev' }, async ($) => ({
    text: [savingsLine('this session', session), savingsLine('all time', await allTimeSavings($))].join('\n'),
  }));

  on('session.compact', async ($, event, next) => {
    // When this plugin triggered the compaction itself, a fallback would summarize
    // at compactAtPercent, far earlier than Claude Code would on its own: skip
    // instead and leave the built-in auto-compaction to its own threshold.
    const fallback = (reason: string) => {
      notify($, `${event.trigger === 'plugin' ? 'skipped' : 'fallback to built-in summary'} (${reason})`);
      return event.trigger === 'plugin' ? { skip: `fast-jev-compaction: ${reason}` } : next(event);
    };
    try {
      const configured = await configure($, options);
      const config = { ...configured, apiKey: await getApiKey($, configured) };
      const before = (await contextTokens($)).tokens;
      const { result, messages } = await compactSession(event.messages, config, async (url, init) => {
        const response = await $.http.fetch(url, init);
        return { status: response.status, ok: response.ok, text: response.text };
      });
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < config.minReductionRatio) {
        return fallback(`below ${percent(config.minReductionRatio)} minimum: ${summarize(result)}`);
      }
      if (event.trigger !== 'precompute') pending = before;
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      return { messages };
    } catch (error) {
      return fallback(error instanceof Error ? error.message : String(error));
    }
  });

  // The first request after a compaction: its input tokens are the "after".
  on('turn.step', async function* ($, event, next) {
    const response = yield* next(event);
    if (pending === undefined) return response;
    const before = pending;
    pending = undefined;
    const { tokens } = await contextTokens($);
    if (tokens === undefined) return response;
    session = add(session, before, tokens);
    await $.store.set('savings', add(await allTimeSavings($), before, tokens));
    $.ui.log(`context ${k(before)} → ${k(tokens)} tokens after Jev compaction (−${k(before - tokens)}); /fast-jev for totals`);
    return response;
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (!commandRegistered) {
      commandRegistered = true;
      await registerCommand($);
    }
    if (compacting) return next(event);
    try {
      const configured = await configure($, options);
      const context = await contextTokens($);
      const current = context.percent ?? 0;
      if (current < Math.max(configured.compactAtPercent, retryAtPercent)) return next(event);
      compacting = true;
      const result = await $.session.compact();
      // Nothing to shrink: retry 10 points later, not every turn.
      retryAtPercent = result.skip ? current + 10 : 0;
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
