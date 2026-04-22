#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseStateFile, type StateFileName } from '../src/lib/schemas/index.js';

const files: Array<{ name: StateFileName; path: string }> = [
  { name: 'sprint-status.json', path: '.vibe/agent/sprint-status.json' },
  { name: 'project-map.json', path: '.vibe/agent/project-map.json' },
  { name: 'sprint-api-contracts.json', path: '.vibe/agent/sprint-api-contracts.json' },
  { name: 'iteration-history.json', path: '.vibe/agent/iteration-history.json' },
  { name: 'model-registry.json', path: '.vibe/model-registry.json' },
];

const errors: Array<{ file: string; message: string; fixSuggestion?: string }> = [];

for (const file of files) {
  const filePath = resolve(file.path);
  if (!existsSync(filePath)) {
    continue;
  }

  const result = parseStateFile(file.name, readFileSync(filePath, 'utf8'));
  if (!result.ok) {
    errors.push({
      file: file.name,
      message: result.error ?? 'unknown validation error',
      ...(result.fixSuggestion === undefined ? {} : { fixSuggestion: result.fixSuggestion }),
    });
  }
}

if (errors.length > 0) {
  process.stderr.write(`${JSON.stringify({ errors })}\n`);
  process.exit(1);
}

process.exit(0);
