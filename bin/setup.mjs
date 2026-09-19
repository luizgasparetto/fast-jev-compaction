#!/usr/bin/env node
// One-shot Claude Code setup: enables function hooks in settings.json, adds the
// plugin marketplace and installs the plugin with the TypeSafe key.
//   npx -y github:luizgasparetto/fast-jev-compaction --key <TypeSafe key>
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PLUGIN = 'fast-jev-compaction@fast-jev-compaction';
const DEFAULT_SOURCE = 'luizgasparetto/fast-jev-compaction';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const key = flag('--key') ?? process.env.TYPESAFE_API_KEY;
const source = flag('--source') ?? DEFAULT_SOURCE;

if (args.includes('-h') || args.includes('--help') || !key) {
  console.log(`Usage: npx -y github:${DEFAULT_SOURCE} --key <TypeSafe key> [--source <marketplace repo or path>]
The key can also come from TYPESAFE_API_KEY. It is stored in Claude Code's secure plugin storage, never in a file of this repo.`);
  process.exit(key ? 0 : 1);
}

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
const claude = (...cmd) =>
  execFileSync('claude', cmd, { stdio: 'inherit', shell: process.platform === 'win32' });
try {
  claude('plugin', 'marketplace', 'add', source);
} catch {
  claude('plugin', 'marketplace', 'update', 'fast-jev-compaction');
}
claude('plugin', 'install', PLUGIN, '--config', `apiKey=${key}`);

console.log('\nDone. Restart Claude Code (or run /reload-plugins). /compact and auto-compaction now go through Jev.');
