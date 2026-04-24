import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const WINDOWS_GIT_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
];

function stripOuterQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }

  return value;
}

function hasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

function resolveCommandFile(command: string, cwd?: string): string {
  const clean = stripOuterQuotes(command);
  return path.isAbsolute(clean) ? clean : path.resolve(cwd ?? process.cwd(), clean);
}

function isShellScriptCommand(command: string): boolean {
  return stripOuterQuotes(command).toLowerCase().endsWith('.sh');
}

function commandFileExists(command: string, cwd?: string): boolean {
  return hasPathSeparator(command) && existsSync(resolveCommandFile(command, cwd));
}

function gitBashFromGitExe(gitExePath: string): string | null {
  const normalized = path.normalize(gitExePath.trim());
  const parts = normalized.split(path.sep);
  const cmdIndex = parts.findLastIndex((part) => part.toLowerCase() === 'cmd');
  if (cmdIndex <= 0) {
    return null;
  }

  const root = parts.slice(0, cmdIndex).join(path.sep);
  const candidate = path.join(root, 'bin', 'bash.exe');
  return existsSync(candidate) ? candidate : null;
}

export function resolveGitBashPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform !== 'win32') {
    return null;
  }

  const explicit = env.VIBE_GIT_BASH ?? env.GIT_BASH;
  if (explicit && existsSync(explicit)) {
    return explicit;
  }

  for (const candidate of WINDOWS_GIT_BASH_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const result = spawnSync('where.exe', ['git'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  for (const entry of result.stdout.split(/\r?\n/)) {
    const candidate = gitBashFromGitExe(entry);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function quoteCmdArg(value: string): string {
  if (value === '') {
    return '""';
  }

  if (!/[\s&()^|<>"]/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
}

export async function commandExists(
  command: string,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<boolean> {
  if (commandFileExists(command, options?.cwd)) {
    if (process.platform === 'win32' && isShellScriptCommand(command)) {
      return resolveGitBashPath({ ...process.env, ...(options?.env ?? {}) }) !== null;
    }

    return true;
  }

  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = await runCommand(checker, [command], { allowFailure: true });
  return result.exitCode === 0;
}

export async function runCommand(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    allowFailure?: boolean;
  },
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const env = {
      ...process.env,
      ...(options?.env ?? {}),
    };
    const isWin = process.platform === 'win32';
    const commandFile = resolveCommandFile(command, options?.cwd);
    let childCommand = command;
    let childArgs = args;

    if (isWin && isShellScriptCommand(command) && existsSync(commandFile)) {
      const gitBashPath = resolveGitBashPath(env);
      if (!gitBashPath) {
        const result = {
          exitCode: 1,
          stdout: '',
          stderr: `Git Bash not found; cannot run POSIX shell script on Windows: ${command}\n`,
        };
        if (options?.allowFailure) {
          resolve(result);
          return;
        }
        reject(new Error(result.stderr));
        return;
      }
      childCommand = gitBashPath;
      childArgs = [commandFile, ...args];
    } else if (isWin) {
      childCommand = 'cmd.exe';
      childArgs = ['/d', '/s', '/c', [command, ...args].map(quoteCmdArg).join(' ')];
    }

    const child = spawn(childCommand, childArgs, {
      cwd: options?.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      const result = {
        exitCode: code ?? 1,
        stdout,
        stderr,
      };

      if (!options?.allowFailure && result.exitCode !== 0) {
        reject(
          new Error(
            `Command failed: ${command} ${args.join(' ')}
${stderr || stdout}`,
          ),
        );
        return;
      }

      resolve(result);
    });
  });
}
