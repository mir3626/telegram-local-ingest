#!/usr/bin/env node

import { openSync, closeSync, unlinkSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function splitSessionLogSections(content) {
  const entriesHeaderMatch = content.match(/^## Entries\s*$/m);
  if (!entriesHeaderMatch || entriesHeaderMatch.index === undefined) {
    return null;
  }

  const headerEnd = entriesHeaderMatch.index + entriesHeaderMatch[0].length;
  const afterHeaderIndex =
    content[headerEnd] === '\r' && content[headerEnd + 1] === '\n'
      ? headerEnd + 2
      : content[headerEnd] === '\n'
        ? headerEnd + 1
        : headerEnd;
  const rest = content.slice(afterHeaderIndex);
  const archivedMatch = rest.match(/^## /m);
  const bodyEnd = archivedMatch?.index ?? rest.length;

  return {
    header: content.slice(0, afterHeaderIndex),
    entriesBody: rest.slice(0, bodyEnd),
    archivedTail: rest.slice(bodyEnd),
  };
}

function normalizeTimestamp(rawTimestamp) {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(rawTimestamp)) {
    return `${rawTimestamp}:00.000Z`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(rawTimestamp)) {
    return `${rawTimestamp}T00:00:00.000Z`;
  }

  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(rawTimestamp)
  ) {
    const normalized = new Date(rawTimestamp).toISOString();
    return Number.isNaN(Date.parse(normalized)) ? null : normalized;
  }

  return null;
}

function parseEntries(entriesBody) {
  const normalizedEntries = [];
  const malformed = [];
  const dedupeKeys = new Set();
  const lines = entriesBody.split(/\r?\n/);
  let deduped = 0;

  lines.forEach((line, index) => {
    if (line.trim().length === 0) {
      return;
    }

    const match = line.match(/^\-\s+(?<ts>\S+)\s+\[(?<tag>[^\]]+)\]\s*(?<body>.*)$/);
    if (!match?.groups) {
      malformed.push(line);
      return;
    }

    const normalizedTs = normalizeTimestamp(match.groups.ts);
    if (!normalizedTs) {
      malformed.push(line);
      return;
    }

    const entry = {
      normalizedTs,
      tag: match.groups.tag,
      body: match.groups.body,
      originalIndex: index,
    };
    const key = `${entry.normalizedTs}\u0000${entry.tag}\u0000${entry.body}`;
    if (dedupeKeys.has(key)) {
      deduped += 1;
      return;
    }

    dedupeKeys.add(key);
    normalizedEntries.push(entry);
  });

  normalizedEntries.sort((left, right) => {
    const tsOrder = right.normalizedTs.localeCompare(left.normalizedTs);
    return tsOrder !== 0 ? tsOrder : left.originalIndex - right.originalIndex;
  });

  return {
    normalizedEntries,
    malformed,
    deduped,
  };
}

function normalizeSessionLogContent(content) {
  const sections = splitSessionLogSections(content);
  if (!sections) {
    throw new Error('missing ## Entries section');
  }

  const { normalizedEntries, malformed, deduped } = parseEntries(sections.entriesBody);
  const serializedEntries = normalizedEntries.map(
    (entry) => `- ${entry.normalizedTs} [${entry.tag}] ${entry.body}`,
  );
  const rebuiltParts = [sections.header];

  if (serializedEntries.length > 0) {
    rebuiltParts.push(`${serializedEntries.join('\n')}\n`);
  }

  if (malformed.length > 0) {
    rebuiltParts.push(malformed.join('\n'));
    if (sections.archivedTail.length > 0) {
      rebuiltParts.push('\n');
    }
  }

  rebuiltParts.push(sections.archivedTail);

  let nextContent = rebuiltParts.join('');
  nextContent = nextContent.replace(/\r\n/g, '\n');
  if (!nextContent.endsWith('\n')) {
    nextContent += '\n';
  }

  return {
    content: nextContent,
    normalized: normalizedEntries.length,
    deduped,
    malformed: malformed.length,
    changed: nextContent !== content.replace(/\r\n/g, '\n') || content.includes('\r\n'),
  };
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function acquireLock(lockPath) {
  const timeoutMs = Number(process.env.VIBE_LOCK_TIMEOUT_MS ?? '5000');
  const startedAt = Date.now();

  while (true) {
    try {
      const handle = openSync(lockPath, 'wx');
      return handle;
    } catch {
      if (Date.now() - startedAt >= timeoutMs) {
        process.stderr.write(`lock held by another process: ${lockPath}\n`);
        process.exit(2);
      }
      await sleep(100);
    }
  }
}

async function main() {
  const logPath = resolve(process.argv[2] ?? '.vibe/agent/session-log.md');
  const lockPath = `${logPath}.lock`;
  const lockHandle = await acquireLock(lockPath);

  try {
    const currentContent = readFileSync(logPath, 'utf8');
    const summary = normalizeSessionLogContent(currentContent);

    if (summary.changed) {
      writeFileSync(logPath, summary.content, 'utf8');
    } else {
      process.stdout.write('session-log already normalized\n');
    }

    process.stdout.write(
      `normalized=${summary.normalized} deduped=${summary.deduped} malformed=${summary.malformed} changed=${summary.changed ? 'yes' : 'no'}\n`,
    );
  } finally {
    closeSync(lockHandle);
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
