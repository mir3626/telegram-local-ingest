import { execFile as execFileCallback } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { readDecisions, type ProjectDecision } from './decisions.js';
import { fileExists, readJson, readText } from './fs.js';
import { paths } from './paths.js';
import { loadSprintStatus, type PendingRisk } from './sprint-status.js';

const execFile = promisify(execFileCallback);
const DEFAULT_RECENT_ENTRIES = 50;
const DEFAULT_GIT_COMMITS = 20;
const PHASE3_UTILITY_OPT_IN_TAG = '[decision][phase3-utility-opt-in]';
const WEB_PLATFORM_PATTERN = /\b(web|mobile|browser)\b/i;
const PRODUCT_FETCHER_ROUTE_FILES = new Set(['route.ts', 'route.tsx', 'route.mjs', 'route.js']);
const PRODUCT_FETCHER_SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.vibe']);

export interface PendingRestoration {
  sourceFile: string;
  ruleSlug: string;
  title: string;
  tier: 'S' | 'A' | 'B' | 'C';
  reason: string;
}

export interface ReviewInputs {
  handoff: string;
  sessionLog: string;
  recentSessionEntries: string[];
  recentEntriesLimit: number;
  gitLog: string[];
  gitLogMode: 'recent' | 'since-last-review';
  gitCommitLimit: number;
  latestReviewReportPath: string | null;
  openPendingRisks: PendingRisk[];
  decisions: ProjectDecision[];
  passedSprintCount: number;
  productText: string;
  harnessGaps: string;
  openHarnessGapCount: number;
  pendingRestorations: PendingRestoration[];
  productFetcherPaths: string[];
}

export interface ReviewConfigInput {
  bundle?: {
    enabled?: boolean;
  };
  browserSmoke?: {
    enabled?: boolean;
  };
}

export interface ReviewSeedInput {
  productText?: string;
  platform?: string | string[];
  sessionLogRecent?: string[];
}

export interface ReviewIssueSeed {
  id: string;
  severity: 'friction';
  priority: 'P1';
  proposal: string;
  estimated_loc: number;
  proposed_sprint: 'backlog';
}

export interface PriorReviewIssue {
  id: string;
  severity: 'blocker' | 'friction' | 'polish' | 'structural';
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  proposal: string;
  sourceReportPath: string;
  sourceReportDate: string;
}

export interface RegressionStatus {
  issue: PriorReviewIssue;
  status: 'covered' | 'partial' | 'open';
  evidence: string[];
}

export interface IssueWeights {
  agentFriendly: number;
  tokenEfficient: number;
  userFyi: number;
}

function resolveRoot(root?: string): string {
  return root ?? paths.root;
}

function handoffPath(root?: string): string {
  return path.join(resolveRoot(root), '.vibe', 'agent', 'handoff.md');
}

function sessionLogPath(root?: string): string {
  return path.join(resolveRoot(root), '.vibe', 'agent', 'session-log.md');
}

function sharedConfigPath(root?: string): string {
  return path.join(resolveRoot(root), '.vibe', 'config.json');
}

function productPath(root?: string): string {
  return path.join(resolveRoot(root), 'docs', 'context', 'product.md');
}

function harnessGapsPath(root?: string): string {
  return path.join(resolveRoot(root), 'docs', 'context', 'harness-gaps.md');
}

function archiveRulesDeletedPath(root?: string): string {
  return path.join(resolveRoot(root), '.vibe', 'archive');
}

function auditPath(root?: string): string {
  return path.join(resolveRoot(root), '.vibe', 'audit');
}

function reportsPath(root?: string): string {
  return path.join(resolveRoot(root), 'docs', 'reports');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReviewSeverity(value: string): value is PriorReviewIssue['severity'] {
  return value === 'blocker' || value === 'friction' || value === 'polish' || value === 'structural';
}

function isReviewPriority(value: string): value is PriorReviewIssue['priority'] {
  return value === 'P0' || value === 'P1' || value === 'P2' || value === 'P3';
}

function readRecentEntriesLimit(config: unknown): number {
  if (!isRecord(config)) {
    return DEFAULT_RECENT_ENTRIES;
  }

  const review = config.review;
  if (!isRecord(review) || typeof review.recentEntries !== 'number') {
    return DEFAULT_RECENT_ENTRIES;
  }

  return Number.isInteger(review.recentEntries) && review.recentEntries > 0
    ? review.recentEntries
    : DEFAULT_RECENT_ENTRIES;
}

async function readOptionalText(filePath: string): Promise<string> {
  return (await fileExists(filePath)) ? readText(filePath) : '';
}

function extractFindingsSection(markdown: string): string {
  const match = markdown.match(/^## Findings\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  return match?.[1] ?? '';
}

function extractYamlBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const pattern = /```ya?ml\s*([\s\S]*?)```/gi;
  let match = pattern.exec(markdown);
  while (match) {
    blocks.push(match[1] ?? '');
    match = pattern.exec(markdown);
  }
  return blocks.length > 0 ? blocks : [markdown];
}

function parseYamlScalar(line: string, key: string): string | null {
  const match = line.match(new RegExp(`^\\s*-?\\s*${key}:\\s*(.+?)\\s*$`));
  if (!match?.[1]) {
    return null;
  }
  return match[1].replace(/^['"]|['"]$/g, '').trim();
}

function parseRestorationHeading(heading: string): Pick<PendingRestoration, 'ruleSlug' | 'title'> {
  const match = heading.trim().match(/^(.+?)\s+(?:—|-)\s+(.+)$/);
  const title = match?.[2]?.trim() ?? heading.trim();
  const ruleSlug = match?.[1]?.trim() ?? title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return { ruleSlug, title };
}

function validRestorationTier(value: string | null | undefined): value is PendingRestoration['tier'] {
  return value === 'S' || value === 'A' || value === 'B' || value === 'C';
}

function restorationValue(lines: string[], key: string): string | null {
  return lines.map((line) => parseYamlScalar(line, key)).find(Boolean) ?? null;
}

function splitRestorationSection(section: string): { heading: string; lines: string[] } | null {
  const lines = section.split(/\r?\n/);
  const heading = lines[0]?.replace(/^##\s+/, '').trim();
  if (!heading) {
    return null;
  }
  const body = lines.slice(1);
  const boundaryIndex = body.findIndex((line) => /^---\s*$/.test(line));
  return { heading, lines: boundaryIndex === -1 ? body : body.slice(0, boundaryIndex) };
}

function collectDeleteConfirmedSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  for (const section of markdown.split(/\r?\n(?=##\s+)/).filter((entry) => entry.startsWith('## '))) {
    const parsedSection = splitRestorationSection(section);
    if (!parsedSection) continue;
    const scalarDeleteConfirmed = parsedSection.lines.some(
      (line) =>
        parseYamlScalar(line, 'restoration_decision')?.replace(/\*/g, '').toLowerCase() === 'delete-confirmed',
    );
    if (scalarDeleteConfirmed) {
      slugs.add(parseRestorationHeading(parsedSection.heading).ruleSlug);
    }
    const heading = parsedSection.heading.toLowerCase();
    if (/\biter-\d+\b/.test(heading) || heading.includes('delete-confirmed')) {
      for (const line of parsedSection.lines) {
        const slug = /delete-confirmed/i.test(line) ? line.match(/`([^`]+)`/)?.[1]?.trim() : null;
        if (slug) slugs.add(slug);
      }
    }
  }
  return slugs;
}

function parseRestorationSections(markdown: string, sourceFile: string): PendingRestoration[] {
  const restorations: PendingRestoration[] = [];
  const deleteConfirmedSlugs = collectDeleteConfirmedSlugs(markdown);

  for (const section of markdown.split(/\r?\n(?=##\s+)/).filter((entry) => entry.startsWith('## '))) {
    const parsedSection = splitRestorationSection(section);
    if (!parsedSection || restorationValue(parsedSection.lines, 'restoration_decision') !== 'pending') {
      continue;
    }

    const parsedHeading = parseRestorationHeading(parsedSection.heading);
    if (deleteConfirmedSlugs.has(parsedHeading.ruleSlug)) {
      continue;
    }

    const rawTier = restorationValue(parsedSection.lines, 'tier');
    const reason = restorationValue(parsedSection.lines, 'reason') ?? '';

    restorations.push({
      sourceFile,
      ruleSlug: parsedHeading.ruleSlug,
      title: parsedHeading.title,
      tier: validRestorationTier(rawTier) ? rawTier : 'C',
      reason: validRestorationTier(rawTier) ? reason : `[tier-fallback] ${reason}`.trim(),
    });
  }

  return restorations;
}

function parseReviewIssuesFromBlock(
  block: string,
  sourceReportPath: string,
  sourceReportDate: string,
): PriorReviewIssue[] {
  const issues: PriorReviewIssue[] = [];
  const chunks = block
    .split(/\r?\n(?=\s*-\s+id:\s*)/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  for (const chunk of chunks) {
    const lines = chunk
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*-\s+/, '').trimEnd());
    const id = parseYamlScalar(lines[0] ?? '', 'id') ?? parseYamlScalar(chunk, 'id');
    const severity = lines.map((line) => parseYamlScalar(line, 'severity')).find(Boolean);
    const priority = lines.map((line) => parseYamlScalar(line, 'priority')).find(Boolean);
    const proposal = lines.map((line) => parseYamlScalar(line, 'proposal')).find(Boolean);

    if (
      !id ||
      !severity ||
      !priority ||
      !proposal ||
      !isReviewSeverity(severity) ||
      !isReviewPriority(priority)
    ) {
      continue;
    }

    issues.push({
      id,
      severity,
      priority,
      proposal,
      sourceReportPath,
      sourceReportDate,
    });
  }

  return issues;
}

function sourceDateFromFileName(fileName: string, fallbackMtimeMs: number): string {
  return fileName.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? new Date(fallbackMtimeMs).toISOString();
}

function proposalKeywords(proposal: string): string[] {
  return Array.from(
    new Set(
      proposal
        .toLowerCase()
        .split(/[^a-z0-9./_-]+/)
        .filter((word) => word.length >= 3),
    ),
  ).slice(0, 8);
}

function rowHasCoveredStatus(row: string): boolean {
  const cells = row
    .split('|')
    .map((cell) => cell.trim().toLowerCase())
    .filter(Boolean);
  return cells.includes('covered');
}

function pathMentions(proposal: string): string[] {
  return Array.from(new Set(proposal.match(/scripts\/vibe-[a-z0-9-]+\.mjs/gi) ?? [])).map((entry) =>
    entry.replace(/\\/g, '/'),
  );
}

function extractCurrentSessionEntries(sessionLog: string, limit: number): string[] {
  const lines = sessionLog.split(/\r?\n/);
  const entries: string[] = [];
  let inEntries = false;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (inEntries) {
        break;
      }

      inEntries = line.trim() === '## Entries';
      continue;
    }

    if (inEntries && line.startsWith('- ')) {
      entries.push(line);
    }
  }

  return entries.slice(0, limit);
}

async function findLatestReviewReport(root?: string): Promise<string | null> {
  const reportsDir = reportsPath(root);
  if (!(await fileExists(reportsDir))) {
    return null;
  }

  const fileNames = await readdir(reportsDir);
  let latestFile: string | null = null;
  let latestMtime = -1;

  for (const fileName of fileNames) {
    if (!/^review-\d+-\d{4}-\d{2}-\d{2}\.md$/.test(fileName)) {
      continue;
    }

    const absolutePath = path.join(reportsDir, fileName);
    const fileStat = await stat(absolutePath);
    if (fileStat.mtimeMs <= latestMtime) {
      continue;
    }

    latestMtime = fileStat.mtimeMs;
    latestFile = absolutePath;
  }

  return latestFile;
}

async function readLastReviewCommit(
  root: string,
  latestReviewReportPath: string,
): Promise<string | null> {
  try {
    const relativePath = path.relative(root, latestReviewReportPath);
    const { stdout } = await execFile(
      'git',
      ['log', '-n', '1', '--format=%H', '--', relativePath],
      { cwd: root },
    );
    const commit = stdout.trim();
    return commit.length > 0 ? commit : null;
  } catch {
    return null;
  }
}

async function readGitLog(
  root: string,
  latestReviewReportPath: string | null,
): Promise<Pick<ReviewInputs, 'gitLog' | 'gitLogMode' | 'gitCommitLimit'>> {
  const lastReviewCommit =
    latestReviewReportPath === null
      ? null
      : await readLastReviewCommit(root, latestReviewReportPath);

  const args =
    lastReviewCommit === null
      ? ['log', '--oneline', `-${DEFAULT_GIT_COMMITS}`]
      : ['log', '--oneline', `${lastReviewCommit}..HEAD`];

  try {
    const { stdout } = await execFile('git', args, { cwd: root });
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return {
      gitLog: lines,
      gitLogMode: lastReviewCommit === null ? 'recent' : 'since-last-review',
      gitCommitLimit: DEFAULT_GIT_COMMITS,
    };
  } catch {
    return {
      gitLog: [],
      gitLogMode: lastReviewCommit === null ? 'recent' : 'since-last-review',
      gitCommitLimit: DEFAULT_GIT_COMMITS,
    };
  }
}

function countOpenHarnessGaps(markdown: string): number {
  return markdown
    .split(/\r?\n/)
    .filter((line) => /^\|\s*gap-[^|]+\|.*\|\s*open\s*\|$/i.test(line.trim())).length;
}

function sourceFilePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).replace(/\\/g, '/');
}

async function collectProductFetcherPathsInDir(root: string, directory: string, files: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!PRODUCT_FETCHER_SKIP_DIRS.has(entry.name)) {
        await collectProductFetcherPathsInDir(root, path.join(directory, entry.name), files);
      }
      continue;
    }

    if (entry.isFile() && PRODUCT_FETCHER_ROUTE_FILES.has(entry.name)) {
      files.push(path.relative(root, path.join(directory, entry.name)).replace(/\\/g, '/'));
    }
  }
}

async function collectProductFetcherPaths(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const appRoot of ['app', 'src/app'].map((relativeRoot) => path.join(root, relativeRoot))) {
    if (await fileExists(appRoot)) {
      await collectProductFetcherPathsInDir(root, appRoot, files);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function auditIterationPriority(filePath: string): number {
  const match = filePath.replace(/\\/g, '/').match(/\.vibe\/audit\/iter-(\d+)\/rules-deleted\.md$/);
  return match?.[1] ? 1000 + Number.parseInt(match[1], 10) : 1000;
}

async function collectRulesDeletedFiles(
  root: string,
): Promise<Array<{ absolutePath: string; priority: number }>> {
  const files: Array<{ absolutePath: string; priority: number }> = [];
  const archiveDir = archiveRulesDeletedPath(root);
  if (await fileExists(archiveDir)) {
    for (const fileName of await readdir(archiveDir)) {
      if (/^rules-deleted-.*\.md$/i.test(fileName)) {
        files.push({ absolutePath: path.join(archiveDir, fileName), priority: 0 });
      }
    }
  }

  const auditDir = auditPath(root);
  if (await fileExists(auditDir)) {
    for (const dirName of await readdir(auditDir)) {
      const absolutePath = path.join(auditDir, dirName, 'rules-deleted.md');
      if (dirName.startsWith('iter-') && (await fileExists(absolutePath))) {
        files.push({ absolutePath, priority: auditIterationPriority(absolutePath) });
      }
    }
  }

  return files.sort((left, right) => left.priority - right.priority || left.absolutePath.localeCompare(right.absolutePath));
}

export async function collectPendingRestorationDecisions(
  root?: string,
): Promise<PendingRestoration[]> {
  const resolvedRoot = resolveRoot(root);
  const bySlug = new Map<string, PendingRestoration>();

  for (const file of await collectRulesDeletedFiles(resolvedRoot)) {
    const sourceFile = sourceFilePath(resolvedRoot, file.absolutePath);
    for (const restoration of parseRestorationSections(await readText(file.absolutePath), sourceFile)) {
      bySlug.set(restoration.ruleSlug, restoration);
    }
  }

  return [...bySlug.values()];
}

function normalizePlatformSignals(seed: ReviewSeedInput): string[] {
  const signals: string[] = [];

  if (Array.isArray(seed.platform)) {
    signals.push(...seed.platform);
  } else if (typeof seed.platform === 'string') {
    signals.push(seed.platform);
  }

  if (typeof seed.productText === 'string') {
    signals.push(seed.productText);
  }

  return signals;
}

function isWebPlatformSeed(seed: ReviewSeedInput): boolean {
  return normalizePlatformSignals(seed).some((signal) => WEB_PLATFORM_PATTERN.test(signal));
}

function hasUtilityOptInDecision(seed: ReviewSeedInput): boolean {
  return (seed.sessionLogRecent ?? []).some((entry) => entry.includes(PHASE3_UTILITY_OPT_IN_TAG));
}

export async function collectReviewInputs(root?: string): Promise<ReviewInputs> {
  const resolvedRoot = resolveRoot(root);
  const config = await readJson<unknown>(sharedConfigPath(resolvedRoot)).catch(() => ({}));
  const recentEntriesLimit = readRecentEntriesLimit(config);
  const [
    handoff,
    sessionLog,
    status,
    decisions,
    productText,
    harnessGaps,
    latestReviewReportPath,
    pendingRestorations,
    productFetcherPaths,
  ] = await Promise.all([
    readOptionalText(handoffPath(resolvedRoot)),
    readOptionalText(sessionLogPath(resolvedRoot)),
    loadSprintStatus(resolvedRoot),
    readDecisions(resolvedRoot),
    readOptionalText(productPath(resolvedRoot)),
    readOptionalText(harnessGapsPath(resolvedRoot)),
    findLatestReviewReport(resolvedRoot),
    collectPendingRestorationDecisions(resolvedRoot),
    collectProductFetcherPaths(resolvedRoot),
  ]);
  const gitLogState = await readGitLog(resolvedRoot, latestReviewReportPath);

  return {
    handoff,
    sessionLog,
    recentSessionEntries: extractCurrentSessionEntries(sessionLog, recentEntriesLimit),
    recentEntriesLimit,
    gitLog: gitLogState.gitLog,
    gitLogMode: gitLogState.gitLogMode,
    gitCommitLimit: gitLogState.gitCommitLimit,
    latestReviewReportPath,
    openPendingRisks: status.pendingRisks.filter((risk) => risk.status === 'open'),
    decisions,
    passedSprintCount: status.sprints.filter((sprint) => sprint.status === 'passed').length,
    productText,
    harnessGaps,
    openHarnessGapCount: countOpenHarnessGaps(harnessGaps),
    pendingRestorations,
    productFetcherPaths,
  };
}

export function detectOptInGaps(
  config: ReviewConfigInput,
  seed: ReviewSeedInput,
): ReviewIssueSeed[] {
  if (!isWebPlatformSeed(seed) || hasUtilityOptInDecision(seed)) {
    return [];
  }

  const issues: ReviewIssueSeed[] = [];

  if (config.bundle?.enabled !== true) {
    issues.push({
      id: 'review-bundle-opt-in-disabled',
      severity: 'friction',
      priority: 'P1',
      proposal: 'frontend 프로젝트인데 bundle-size gate 가 opt-in 되지 않음',
      estimated_loc: 20,
      proposed_sprint: 'backlog',
    });
  }

  if (config.browserSmoke?.enabled !== true) {
    issues.push({
      id: 'review-browser-smoke-opt-in-disabled',
      severity: 'friction',
      priority: 'P1',
      proposal: 'frontend 프로젝트인데 browser smoke gate 가 opt-in 되지 않음',
      estimated_loc: 20,
      proposed_sprint: 'backlog',
    });
  }

  return issues;
}

export async function loadPriorReviewIssues(root?: string): Promise<PriorReviewIssue[]> {
  const resolvedRoot = resolveRoot(root);
  const reportsDir = reportsPath(resolvedRoot);
  if (!(await fileExists(reportsDir))) {
    return [];
  }

  const fileNames = (await readdir(reportsDir))
    .filter((fileName) => /^review-.*\.md$/i.test(fileName))
    .sort();
  const reports = await Promise.all(
    fileNames.map(async (fileName) => {
      const absolutePath = path.join(reportsDir, fileName);
      const fileStat = await stat(absolutePath);
      return {
        fileName,
        absolutePath,
        mtimeMs: fileStat.mtimeMs,
      };
    }),
  );

  reports.sort((left, right) => right.mtimeMs - left.mtimeMs || right.fileName.localeCompare(left.fileName));

  const byId = new Map<string, PriorReviewIssue>();
  for (const report of reports) {
    const relativePath = path.relative(resolvedRoot, report.absolutePath).replace(/\\/g, '/');
    const sourceReportDate = sourceDateFromFileName(report.fileName, report.mtimeMs);
    const findings = extractFindingsSection(await readText(report.absolutePath));

    for (const block of extractYamlBlocks(findings)) {
      for (const issue of parseReviewIssuesFromBlock(block, relativePath, sourceReportDate)) {
        if (!byId.has(issue.id)) {
          byId.set(issue.id, issue);
        }
      }
    }
  }

  return [...byId.values()];
}

async function readGitEvidence(issueId: string, root: string): Promise<string[]> {
  try {
    const { stdout } = await execFile(
      'git',
      ['log', '--all', `--grep=${issueId}`, '--format=%h'],
      { cwd: root },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((hash) => `git:${hash}`);
  } catch {
    return [];
  }
}

function readHarnessGapEvidence(issue: PriorReviewIssue, harnessGaps: string): string[] {
  const keywords = proposalKeywords(issue.proposal);
  const rows = harnessGaps
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && rowHasCoveredStatus(line));

  return rows
    .filter((row) => {
      const lower = row.toLowerCase();
      if (lower.includes(issue.id.toLowerCase())) {
        return true;
      }
      return keywords.length >= 2 && keywords.filter((keyword) => lower.includes(keyword)).length >= 2;
    })
    .map((row) => `harness-gaps:${row}`)
    .slice(0, 3);
}

async function readFilePathEvidence(issue: PriorReviewIssue, root: string): Promise<string[]> {
  const evidence: string[] = [];
  for (const relativePath of pathMentions(issue.proposal)) {
    if (await fileExists(path.join(root, relativePath))) {
      evidence.push(`file:${relativePath}`);
    }
  }
  return evidence;
}

export async function assessRegression(
  issues: PriorReviewIssue[],
  root?: string,
): Promise<RegressionStatus[]> {
  const resolvedRoot = resolveRoot(root);
  const harnessGaps = await readOptionalText(harnessGapsPath(resolvedRoot));
  const statuses: RegressionStatus[] = [];

  for (const issue of issues) {
    const [gitEvidence, fileEvidence] = await Promise.all([
      readGitEvidence(issue.id, resolvedRoot),
      readFilePathEvidence(issue, resolvedRoot),
    ]);
    const harnessEvidence = readHarnessGapEvidence(issue, harnessGaps);
    const coveredEvidence = [...harnessEvidence, ...fileEvidence];
    const evidence = [...gitEvidence, ...coveredEvidence];
    const status =
      coveredEvidence.length > 0 && gitEvidence.length > 0
        ? 'covered'
        : coveredEvidence.length > 0 || gitEvidence.length > 0
          ? 'partial'
          : 'open';

    statuses.push({ issue, status, evidence });
  }

  return statuses;
}

export function computeRegressionCoverage(statuses: RegressionStatus[]): {
  covered: number;
  partial: number;
  open: number;
  score: number;
} {
  const covered = statuses.filter((entry) => entry.status === 'covered').length;
  const partial = statuses.filter((entry) => entry.status === 'partial').length;
  const open = statuses.filter((entry) => entry.status === 'open').length;

  return {
    covered,
    partial,
    open,
    score: statuses.length === 0 ? 0 : covered / statuses.length,
  };
}

export function computePriorityScore(weights: IssueWeights): number {
  for (const [key, value] of Object.entries(weights)) {
    if (!Number.isInteger(value) || value < 0 || value > 5) {
      throw new Error(`invalid issue weight ${key}: ${value}`);
    }
  }

  return 10 * weights.agentFriendly + 5 * weights.tokenEfficient + weights.userFyi;
}
