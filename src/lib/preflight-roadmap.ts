export interface RoadmapSprintCandidate {
  id: string;
}

export interface ResolveArgs {
  roadmapMd: string;
  currentIterationId: string | null;
  completedSprintIds: ReadonlySet<string>;
}

export interface ResolveResult {
  pendingId: string | null;
  scanScope: 'iteration-scoped' | 'legacy-flat';
  iterationHeader: string | null;
}

export interface IterationSection {
  iterationId: string;
  header: string;
  startLine: number;
  endLine: number;
  body: string;
}

const iterationHeaderPattern = /^(#|##)\s+Iteration\s+(?:iter-)?(\d+)\b[^\n]*$/gm;
const sprintIdPattern = /^- \*\*id\*\*: `([^`]+)`/gm;

function lineNumberAtOffset(md: string, offset: number): number {
  if (offset <= 0) {
    return 0;
  }

  return md.slice(0, offset).split(/\r?\n/).length - 1;
}

function normalizeIterationId(iterationId: string): string {
  const match = iterationId.trim().match(/^(?:iter-)?(\d+)$/);
  return match?.[1] ? `iter-${match[1]}` : iterationId.trim();
}

function firstPendingId(ids: string[], completedSprintIds: ReadonlySet<string>): string | null {
  return ids.find((id) => !completedSprintIds.has(id)) ?? null;
}

export function parseIterationSections(md: string): IterationSection[] {
  const matches = Array.from(md.matchAll(iterationHeaderPattern));

  return matches.flatMap((match, index) => {
    const startOffset = match.index;
    const iterationNumber = match[2];
    if (startOffset === undefined || iterationNumber === undefined) {
      return [];
    }

    const header = match[0];
    const nextStartOffset = matches[index + 1]?.index ?? md.length;
    const bodyStartOffset = startOffset + header.length;
    const body = md.slice(bodyStartOffset, nextStartOffset).replace(/^\r?\n/, '');

    return [
      {
        iterationId: `iter-${iterationNumber}`,
        header,
        startLine: lineNumberAtOffset(md, startOffset),
        endLine: lineNumberAtOffset(md, nextStartOffset),
        body,
      },
    ];
  });
}

export function extractSprintIdsFromSection(body: string): string[] {
  return Array.from(body.matchAll(sprintIdPattern), (match) => match[1]).filter(
    (id): id is string => typeof id === 'string' && id.trim() !== '',
  );
}

export function resolveNextSprintFromRoadmap(args: ResolveArgs): ResolveResult {
  const sections = parseIterationSections(args.roadmapMd);
  if (sections.length === 0 || args.currentIterationId === null) {
    return {
      pendingId: firstPendingId(extractSprintIdsFromSection(args.roadmapMd), args.completedSprintIds),
      scanScope: 'legacy-flat',
      iterationHeader: null,
    };
  }

  const normalizedCurrentIterationId = normalizeIterationId(args.currentIterationId);
  const section = sections.find((entry) => entry.iterationId === normalizedCurrentIterationId);
  if (!section) {
    return {
      pendingId: null,
      scanScope: 'iteration-scoped',
      iterationHeader: null,
    };
  }

  return {
    pendingId: firstPendingId(extractSprintIdsFromSection(section.body), args.completedSprintIds),
    scanScope: 'iteration-scoped',
    iterationHeader: section.header,
  };
}
