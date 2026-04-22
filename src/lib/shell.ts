import { spawn } from 'node:child_process';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function commandExists(command: string): Promise<boolean> {
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
    const child = isWin
      ? spawn('cmd.exe', ['/d', '/s', '/c', command, ...args], {
          cwd: options?.cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsVerbatimArguments: true,
        })
      : spawn(command, args, {
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
