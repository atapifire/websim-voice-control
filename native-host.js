#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const AGENT_BIN = '/home/agent/.npm-global/bin';
const OPEN_BLOCKER_DIR = '/tmp/websim-voice-control-bin';

function agentEnvironment() {
  mkdirSync(OPEN_BLOCKER_DIR, { recursive: true });
  const blocker = '#!/bin/sh\n# Browser navigation is owned by the extension.\nexit 0\n';
  try {
    for (const name of ['xdg-open', 'open']) {
      const blockerPath = `${OPEN_BLOCKER_DIR}/${name}`;
      writeFileSync(blockerPath, blocker, { mode: 0o755 });
      chmodSync(blockerPath, 0o755);
    }
  } catch {}
  return {
    ...process.env,
    PATH: `${OPEN_BLOCKER_DIR}:${AGENT_BIN}:${process.env.PATH || ''}`
  };
}

function cliExecutable() {
  const candidates = [
    process.env.WEBSIM_CLI_BIN,
    '/home/agent/.npm-global/bin/websim-cli',
    '/usr/local/bin/websim-cli',
    'websim-cli'
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === 'websim-cli') {
      const pathDirs = (process.env.PATH || '').split(':').filter(Boolean);
      for (const dir of pathDirs) {
        const resolved = `${dir}/websim-cli`;
        try { accessSync(resolved, constants.X_OK); return resolved; } catch {}
      }
      continue;
    }
    try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error('websim-cli executable not found. Set WEBSIM_CLI_BIN or add websim-cli to PATH.');
}

function writeMessage(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

let input = Buffer.alloc(0);
let activeChild = null;
let activeCancelled = false;
process.stdin.on('data', chunk => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (input.length < length + 4) return;
    const message = JSON.parse(input.subarray(4, length + 4).toString('utf8'));
    input = input.subarray(length + 4);
    run(message).catch(error => writeMessage({ ok: false, error: error.message }));
  }
});

function run(message) {
  if (message.kind === 'codex-status') return runCodexStatus();
  if (message.kind === 'cancel-codex') {
    if (activeChild) {
      activeCancelled = true;
      activeChild.kill('SIGTERM');
      writeMessage({ kind: 'progress', text: 'Codex stop requested.' });
    }
    return Promise.resolve();
  }
  if (message.kind === 'codex') return runCodex(message);
  const args = Array.isArray(message.args) ? message.args.map(String) : [];
  if (!args.length) {
    writeMessage({ ok: false, error: 'No websim-cli command was provided.' });
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const child = spawn(cliExecutable(), args, { cwd: process.env.WEBSIM_CLI_CWD || process.cwd(), env: agentEnvironment() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { writeMessage({ ok: false, error: error.message }); resolve(); });
    child.on('close', code => {
      writeMessage({ ok: code === 0, code, stdout, stderr });
      resolve();
    });
  });
}

function runCodexStatus() {
  try {
    const config = readFileSync('/home/agent/.codex/config.toml', 'utf8');
    const model = config.match(/^model\s*=\s*["']([^"']+)["']/m)?.[1] || '';
    const reasoning = config.match(/^model_reasoning_effort\s*=\s*["']([^"']+)["']/m)?.[1] || '';
    writeMessage({ ok: true, model, reasoning });
  } catch (error) {
    writeMessage({ ok: false, error: error.message });
  }
  return Promise.resolve();
}

function runCodex(message) {
  const prompt = String(message.prompt || '').trim();
  if (!prompt) {
    writeMessage({ ok: false, error: 'No Codex prompt was provided.' });
    return Promise.resolve();
  }
  if (/(?:create|make|start) (?:a |an )?(?:(?:new|blank|fresh) )?websim project/i.test(prompt)) return runWebsimCreate();
  const args = ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
  if (message.model) args.push('--model', String(message.model));
  if (message.reasoning) args.push('--config', `model_reasoning_effort=${JSON.stringify(String(message.reasoning))}`);
  const outputFile = `/tmp/websim-codex-${process.pid}.txt`;
  args.push('--output-last-message', outputFile);
  args.push(prompt);
  if (activeChild) {
    writeMessage({ kind: 'codex-done', ok: false, error: 'A Codex task is already running.' });
    return Promise.resolve();
  }
  activeCancelled = false;
  return new Promise(resolve => {
    const child = spawn('/home/agent/.local/bin/codex', args, {
      cwd: process.env.WEBSIM_CLI_CWD || process.cwd(),
      env: agentEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    activeChild = child;
    let stdout = '';
    let stderr = '';
    let pending = '';
    let doneSent = false;
    child.stdout.on('data', chunk => {
      stdout += chunk;
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) emitProgress(line);
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      for (const line of chunk.toString().split('\n')) if (line.trim()) emitProgressText(`Codex: ${line.trim()}`);
    });
    child.on('error', error => {
      if (doneSent) return;
      doneSent = true;
      activeChild = null;
      writeMessage({ kind: 'codex-done', ok: false, error: error.message });
      resolve();
    });
    child.on('close', code => {
      if (doneSent) return;
      doneSent = true;
      if (pending.trim()) emitProgress(pending);
      let finalMessage = '';
      try { finalMessage = readFileSync(outputFile, 'utf8'); unlinkSync(outputFile); } catch {}
      activeChild = null;
      const resultText = finalMessage || stdout;
      const projectUrl = resultText.match(/https?:\/\/websim\.com\/(?:p\/|@)[^\s)]+/)?.[0];
      writeMessage({ kind: 'codex-done', ok: !activeCancelled && code === 0, code, stdout: resultText, stderr, projectUrl, error: activeCancelled ? 'Cancelled by user' : undefined });
      activeCancelled = false;
      resolve();
    });
  });
}

function runWebsimCreate() {
  writeMessage({ kind: 'progress', text: 'Creating a new Websim project with websim-cli…' });
  return new Promise(resolve => {
    const child = spawn(cliExecutable(), ['projects', 'create', '--json'], { cwd: process.env.WEBSIM_CLI_CWD || process.cwd(), env: agentEnvironment() });
    activeChild = child;
    let stdout = '';
    let stderr = '';
    let doneSent = false;
    child.stdout.on('data', chunk => {
      stdout += chunk;
      emitCliOutput(chunk.toString());
    });
    child.stderr.on('data', chunk => { stderr += chunk; emitProgressText(`websim-cli: ${chunk.toString().trim()}`); });
    child.on('error', error => {
      if (doneSent) return;
      doneSent = true;
      activeChild = null;
      writeMessage({ kind: 'codex-done', ok: false, error: error.message });
      resolve();
    });
    child.on('close', code => {
      if (doneSent) return;
      doneSent = true;
      activeChild = null;
      let result;
      try {
        const jsonStart = stdout.indexOf('{');
        result = JSON.parse(jsonStart >= 0 ? stdout.slice(jsonStart) : stdout);
      } catch {}
      const project = result?.project || result?.data?.project || result;
      const username = project?.created_by?.username || project?.owner?.username;
      const version = result?.project_revision?.version || result?.data?.project_revision?.version;
      const projectUrl = project?.slug && username
        ? `https://websim.com/@${username}/${project.slug}`
        : project?.id ? `https://websim.com/p/${project.id}${version ? `/${version}` : ''}` : undefined;
      const cancelled = activeCancelled;
      activeCancelled = false;
      writeMessage({ kind: 'codex-done', ok: !cancelled && code === 0, code, stdout, stderr, projectUrl: cancelled ? undefined : projectUrl, error: cancelled ? 'Cancelled by user' : (code === 0 ? undefined : stderr.trim() || 'websim-cli project creation failed.') });
      resolve();
    });
  });
}

function emitProgressText(text) {
  if (text && text.trim()) writeMessage({ kind: 'progress', text: text.trim().slice(0, 2000), speak: false });
}

function inspectAuthText(text) {
  const value = String(text || '');
  const loginUrl = value.match(/https:\/\/websim\.com\/_cli-login\?challengeId=[A-Za-z0-9-]+/)?.[0];
  if (loginUrl) writeMessage({ kind: 'login-required', url: loginUrl, text: 'Websim login is required. Opening the login page…', speak: true });
  if (/you are now logged in|token validated successfully|login process completed/i.test(value)) {
    writeMessage({ kind: 'login-complete', text: 'Websim login completed.', speak: true });
  }
}

function emitCliOutput(output) {
  for (const rawLine of String(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    inspectAuthText(line);
    if (/https:\/\/websim\.com\/_cli-login\?challengeId=/.test(line)) continue;
    if (!line.startsWith('{')) emitProgressText(`websim-cli: ${line}`);
  }
}

function emitProgress(line) {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line);
    const item = event.item || {};
    const command = item.command_execution?.command || item.command || event.command_execution?.command || event.command;
    const commandOutput = item.command_execution?.aggregated_output || item.command_execution?.output || item.aggregated_output || item.output || event.output;
    const text = item.text || item.message || event.message?.content || event.text || event.delta || command || commandOutput;
    const detail = typeof text === 'string' && text.trim()
      ? text.trim()
      : JSON.stringify(event);
    const commandDetail = item.type === 'command_execution' && commandOutput
      ? `${command || 'command'}\n${commandOutput}`
      : detail;
    inspectAuthText(commandDetail);
    const speak = event.type === 'item.completed' && item.type === 'agent_message';
    writeMessage({ kind: 'progress', text: `Codex ${event.type || 'output'}: ${commandDetail}`.slice(0, 12000), speak, speakText: speak ? detail.slice(0, 500) : undefined });
  } catch {
    writeMessage({ kind: 'progress', text: `Codex: ${line.trim()}`.slice(0, 2000), speak: false });
  }
}
