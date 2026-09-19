// Dry-runs the compaction over a real Claude Code transcript, to see what Jev would keep:
//   TYPESAFE_API_KEY=... npx tsx examples/session.ts ~/.claude/projects/<project>/<session>.jsonl
//   npx tsx examples/session.ts <session.jsonl> --dry   # no Jev call: transcript and state sizes only
import { readFileSync } from 'node:fs';
import {
  batchCalls,
  collectToolCalls,
  compactMessages,
  fitState,
  messageChars,
  reductionRatio,
  resolveOptions,
  type Message,
  type ToolResult,
  type ToolUse,
} from '../src/index.js';

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content?: string | { type: string; text?: string }[]; is_error?: boolean }
  | { type: string };
type Line = { type?: string; isSidechain?: boolean; message?: { role: 'user' | 'assistant'; content: string | Block[] } };

function blockText(content: Block[] | string | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.map((b) => ('text' in b && typeof b.text === 'string' ? b.text : '')).join('\n');
}

/** Claude Code session JSONL to `Message[]`, one message per transcript line. */
export function messagesFromJsonl(jsonl: string): Message[] {
  const messages: Message[] = [];
  const uses = new Map<string, ToolUse>();
  for (const raw of jsonl.split('\n')) {
    if (!raw) continue;
    const line = JSON.parse(raw) as Line;
    if ((line.type !== 'user' && line.type !== 'assistant') || line.isSidechain || !line.message) continue;
    const content = line.message.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content } as Block] : content;
    const message: Message = { role: line.message.role, text: '', toolUses: [] };
    const texts: string[] = [];
    for (const block of blocks) {
      if (block.type === 'text' && 'text' in block) texts.push(block.text);
      else if (block.type === 'tool_use' && 'id' in block) {
        const use: ToolUse = { tool_use_id: block.id, tool: block.name, input: block.input };
        uses.set(block.id, use);
        message.toolUses.push(use);
      } else if (block.type === 'tool_result' && 'tool_use_id' in block) {
        const result: ToolResult = { tool_use_id: block.tool_use_id, text: blockText(block.content), isError: block.is_error ?? false };
        const use = uses.get(block.tool_use_id);
        if (use) Object.assign(use, { text: result.text, isError: result.isError });
        (message.toolResults ??= []).push(result);
      }
    }
    message.text = texts.join('\n');
    if (message.text || message.toolUses.length || message.toolResults?.length) messages.push(message);
  }
  return messages;
}

const [path, ...flags] = process.argv.slice(2);
if (!path) {
  console.error('usage: npx tsx examples/session.ts <session.jsonl> [--dry]');
  process.exit(1);
}
const messages = messagesFromJsonl(readFileSync(path, 'utf8'));
const options = resolveOptions();
const calls = collectToolCalls(messages, options.preserveRecentMessages);
const chars = messages.reduce((sum, m) => sum + messageChars(m), 0);
console.log(`${messages.length} messages, ${chars} chars, ${calls.length} tool calls (${calls.filter((c) => c.pinned).length} pinned)`);
const fitted = fitState(messages, calls, options);
const batches = batchCalls(calls.filter((c) => !c.pinned), fitted.tokens, options);
console.log(`state ~${fitted.tokens} tokens (stage: ${fitted.stage}), ${batches.length} Jev request(s)`);

if (!flags.includes('--dry')) {
  const result = await compactMessages(messages);
  const width = Math.max(...result.decisions.map((d) => d.tool.length));
  for (const d of result.decisions) {
    const call = calls.find((c) => c.id === d.id)!;
    const input = JSON.stringify(call.input).slice(0, 70);
    console.log(`${d.id.padEnd(5)} ${d.tool.padEnd(width)} ${d.action.padEnd(11)} call=${d.keepCall.toFixed(2)} result=${d.keepResult.toFixed(2)} ${String(call.resultChars).padStart(7)}ch ${input}`);
  }
  const s = result.stats;
  console.log(`\n${Math.round(reductionRatio(result) * 100)}% reduction: ${s.charsBefore} -> ${s.charsAfter} chars, ${s.messagesBefore} -> ${s.messagesAfter} messages; kept ${s.kept}, results truncated ${s.resultsDropped}, calls dropped ${s.callsDropped}, pinned ${s.pinned}; ${s.requests} request(s), ${s.ms} ms`);
}
