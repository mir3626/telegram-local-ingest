import process from 'node:process';
import path from 'node:path';
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

  const exists = await commandExists(plan.command);
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
