#!/usr/bin/env node
// One-shot Claude Code setup: enables function hooks in settings.json, adds the
// plugin marketplace and installs the plugin with the TypeSafe key.
//   npx -y github:luizgasparetto/fast-jev-compaction              # asks for the key
//   npx -y github:luizgasparetto/fast-jev-compaction --key <key>  # or TYPESAFE_API_KEY in env
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

const PLUGIN = 'fast-jev-compaction@fast-jev-compaction';
const DEFAULT_SOURCE = 'luizgasparetto/fast-jev-compaction';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (args.includes('-h') || args.includes('--help')) {
  console.log(`Usage: npx -y github:${DEFAULT_SOURCE} [--key <TypeSafe key>] [--source <marketplace repo or path>]
Without --key (or TYPESAFE_API_KEY in the environment) the key is asked for, hidden.
It is stored in Claude Code's secure plugin storage, never in a file of this repo.`);
  process.exit(0);
}

const fail = (message) => {
  console.error(`x  ${message}`);
  process.exit(1);
};
const claude = (...cmd) =>
  execFileSync('claude', cmd, { stdio: 'inherit', shell: process.platform === 'win32' });

// 0. Preflight: Node 18+ and the claude CLI.
if (Number(process.versions.node.split('.')[0]) < 18) fail(`Node 18+ needed, found ${process.version}`);
try {
  execFileSync('claude', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
} catch {
  fail('the `claude` CLI is not on PATH: install Claude Code first (https://claude.com/claude-code)');
}

const key = flag('--key') ?? process.env.TYPESAFE_API_KEY ?? (await askKey());
if (!key) fail('no key given');

// 1. Function hooks are early access: the flag must be in the env Claude Code starts with.
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const settingsPath = join(configDir, 'settings.json');
const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
if (settings.env?.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS !== '1') {
  settings.env = { ...settings.env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' };
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}
console.log(`ok  ${settingsPath}: env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`);

// 2. Marketplace + plugin. `marketplace add` fails when already added; `update` refreshes it then.
const source = flag('--source') ?? DEFAULT_SOURCE;
try {
  claude('plugin', 'marketplace', 'add', source);
} catch {
  claude('plugin', 'marketplace', 'update', 'fast-jev-compaction');
}
claude('plugin', 'install', PLUGIN, '--config', `apiKey=${key}`);

console.log(`
ok  installed. Restart Claude Code or run /reload-plugins.
    /compact and auto-compaction now go through Jev; /fast-jev shows the tokens saved.
    Tuning: FAST_JEV_* variables in the env of ${settingsPath} (see README).`);

/** Asks for the key without echoing it. */
async function askKey() {
  if (!process.stdin.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const hidden = rl._writeToOutput;
  rl._writeToOutput = (text) => hidden.call(rl, text.startsWith('TypeSafe') ? text : text.replace(/[^\r\n]/g, '*'));
  try {
    return (await rl.question('TypeSafe API key (https://typesafe.ai, hidden): ')).trim();
  } finally {
    rl.close();
    console.log();
  }
}
