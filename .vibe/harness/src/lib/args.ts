export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positionals: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current) {
      continue;
    }

    if (!current.startsWith('--')) {
      positionals.push(current);
      continue;
    }

    const keyValue = current.slice(2).split('=');
    const key = keyValue[0];
    const explicitValue = keyValue[1];

    if (!key) {
      continue;
    }

    if (explicitValue !== undefined) {
      flags[key] = explicitValue;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
      continue;
    }

    flags[key] = true;
  }

  return { flags, positionals };
}

export function getStringFlag(
  args: ParsedArgs,
  name: string,
  fallback?: string,
): string | undefined {
  const value = args.flags[name];
  if (typeof value === 'string') {
    return value;
  }

  return fallback;
}

export function getBooleanFlag(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === 'true';
}
