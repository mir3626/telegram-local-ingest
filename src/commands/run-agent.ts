import process from 'node:process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseArgs, getStringFlag, getBooleanFlag } from '../lib/args.js';
import { runMain } from '../lib/cli.js';
import { loadConfig } from '../lib/config.js';
import { appendJsonl, readText } from '../lib/fs.js';
import { logger } from '../lib/logger.js';
import { paths } from '../lib/paths.js';
import { commandExists, runCommand } from '../lib/shell.js';
import { isoDate, isoStamp } from '../lib/time.js';
import { extractUsage } from '../lib/usage.js';
import { buildExecutionPlan } from '../providers/runner.js';

async function resolvePrompt(
  promptFile: string | undefined,
  promptFlag: string | undefined,
): Promise<string> {
  if (promptFlag) {
    return promptFlag;
  }

  if (promptFile) {
    return readText(promptFile);
  }

  throw new Error('Provide --prompt or --prompt-file');
}

function runAgentSessionStart(cwd: string): void {
  if (process.env.VIBE_SKIP_AGENT_SESSION_START === '1') {
    return;
  }

  const scriptPath = path.join(cwd, 'scripts', 'vibe-agent-session-start.mjs');
  if (!existsSync(scriptPath)) {
    return;
  }

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd,
    env: { ...process.env, VIBE_ROOT: cwd },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.stdout) {
    process.stderr.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.error) {
    process.stderr.write(`[vibe:run-agent] session-start skipped: ${result.error.message}\n`);
  } else if (typeof result.status === 'number' && result.status !== 0) {
    process.stderr.write(`[vibe:run-agent] session-start exited ${result.status}\n`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = getStringFlag(args, 'provider');
  const role = getStringFlag(args, 'role', 'coder') ?? 'coder';
  const promptFile = getStringFlag(args, 'prompt-file');
  const promptFlag = getStringFlag(args, 'prompt');
  const cwd = getStringFlag(args, 'cwd', paths.root) ?? paths.root;
  const taskId = getStringFlag(args, 'task-id', isoStamp()) ?? isoStamp();
  const dryRun = getBooleanFlag(args, 'dry-run');

  if (!provider) {
    throw new Error('Missing --provider');
  }

  const prompt = await resolvePrompt(promptFile, promptFlag);
  const config = await loadConfig();
  const runner = config.providers[provider];

  if (!runner) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const plan = buildExecutionPlan({
    provider,
    role,
    prompt,
    promptFile,
    cwd,
    taskId,
    runner,
  });

  logger.info(`provider=${provider} role=${role}`);
  logger.info(`command=${plan.command} ${plan.args.join(' ')}`);

  const outputFile = path.join(paths.vibeRunsDir, isoDate(), `${taskId}.jsonl`);

  if (dryRun) {
    await appendJsonl(outputFile, {
      type: 'agent-run',
      timestamp: new Date().toISOString(),
      provider,
      role,
      dryRun: true,
      command: plan.command,
      args: plan.args,
    });
    return;
  }

  runAgentSessionStart(cwd);

  const exists = await commandExists(plan.command, { cwd, env: plan.env });
  if (!exists) {
    throw new Error(`Provider command not found: ${plan.command}`);
  }

  const result = await runCommand(plan.command, plan.args, {
    cwd,
    env: plan.env,
    allowFailure: true,
  });

  const usage = extractUsage(
    [result.stdout, result.stderr].filter(Boolean).join('\n'),
    provider,
  );

  await appendJsonl(outputFile, {
    type: 'agent-run',
    timestamp: new Date().toISOString(),
    provider,
    role,
    exitCode: result.exitCode,
    usage,
    stdoutPreview: result.stdout.slice(0, 2000),
    stderrPreview: result.stderr.slice(0, 2000),
  });

  if (result.stdout.trim()) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr.trim()) {
    process.stderr.write(result.stderr);
  }

  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode;
  }
}

runMain(main, import.meta.url);
