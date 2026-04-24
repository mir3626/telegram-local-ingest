#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const KEYWORDS = ['MUST NOT', 'MUST', 'NEVER', '반드시', '절대', '금지', '필수', 'Must', 'Should'];
const SOFT_VERB_RE = /\bShould\b|권장|가능하면|가능한 경우|선택적으로|추천|원칙적으로/i;
const TAGS = ['failure', 'drift-observed', 'decision', 'audit-clear'];
const STOPWORDS = new Set('the and with this that from into when then only must should never 반드시 절대 금지 필수 한다 되는 있다 대한 으로 에서 또는 sprint scripts node mjs docs context agent claude codex orchestrator planner evaluator phase vibe json test grep tsc self-qa product architecture session-log run-codex'.split(' '));
const DISPOSITIONS = new Set(['covered', 'pending', 'manual-review', 'delete-candidate']);

function parseArgs(argv) {
  const options = { format: 'text', claudeMd: './CLAUDE.md', gaps: './docs/context/harness-gaps.md' };
  const args = argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const set = (name, value) => { options[name] = value; };
    if (arg.startsWith('--format=')) set('format', arg.slice(9) === 'json' ? 'json' : 'text');
    else if (arg === '--format') { set('format', (args[index + 1] ?? '') === 'json' ? 'json' : 'text'); index += 1; }
    else if (arg.startsWith('--claude-md=')) set('claudeMd', arg.slice(12));
    else if (arg === '--claude-md') { set('claudeMd', args[index + 1] ?? options.claudeMd); index += 1; }
    else if (arg.startsWith('--gaps=')) set('gaps', arg.slice(7));
    else if (arg === '--gaps') { set('gaps', args[index + 1] ?? options.gaps); index += 1; }
    else if (arg.startsWith('--scan-transcripts=')) set('scanTranscripts', arg.slice(19));
    else if (arg === '--scan-transcripts') { set('scanTranscripts', args[index + 1] ?? ''); index += 1; }
    else if (arg.startsWith('--emit-report-md=')) set('emitReportMd', arg.slice(17));
    else if (arg === '--emit-report-md') { set('emitReportMd', args[index + 1] ?? ''); index += 1; }
    else if (arg === '--fail-on-undisposed') set('failOnUndisposed', true);
  }
  return options;
}

function findKind(line) {
  const upper = line.toUpperCase();
  for (const keyword of KEYWORDS) {
    if (/^[A-Z ]+$/.test(keyword)) {
      if (upper.includes(keyword)) {
        return keyword;
      }
      continue;
    }

    if (line.includes(keyword)) {
      return keyword;
    }
  }

  return null;
}

function extractRules(content) {
  const rules = [];
  let inFence = false;

  content.split(/\r?\n/).forEach((line, index) => {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      return;
    }

    const text = line.trim();
    if (inFence || text.length === 0) {
      return;
    }

    const kind = findKind(text);
    if (kind) {
      rules.push({ line: index + 1, text, kind });
    }
  });

  return rules;
}

function splitMarkdownRow(line) {
  const cells = [];
  let current = '';

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const previous = index > 0 ? line[index - 1] : '';
    if (char === '|' && previous !== '\\') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  cells.push(current.trim());
  return cells.filter((cell, index, array) => !(index === 0 && cell === '') && !(index === array.length - 1 && cell === ''));
}

function extractCoveredGaps(content) {
  const rows = extractGapRows(content);
  return new Set([...rows.values()].filter((row) => row.disposition === 'covered').map((row) => row.id));
}

function normalizeDisposition(status, scriptGate) {
  const normalizedStatus = String(status ?? '').trim().toLowerCase();
  const normalizedGate = String(scriptGate ?? '').trim().toLowerCase();

  if (DISPOSITIONS.has(normalizedGate)) {
    return normalizedGate;
  }
  if (normalizedGate === 'partial') {
    return 'manual-review';
  }
  if (normalizedStatus === 'covered' || normalizedStatus === 'closed') {
    return 'covered';
  }
  if (normalizedStatus === 'open' || normalizedStatus === 'partial' || normalizedStatus === 'under-review') {
    return 'pending';
  }
  return 'undisposed';
}

function extractGapRows(content) {
  const rows = new Map();

  for (const line of content.split(/\r?\n/)) {
    if (!/^\|\s*gap-[\w-]+\s*\|/.test(line)) {
      continue;
    }

    const cells = splitMarkdownRow(line);
    const id = cells[0];
    const status = cells[3];
    const scriptGate = cells[4];
    if (typeof id === 'string') {
      rows.set(id, {
        id,
        status: status ?? '',
        scriptGate: scriptGate ?? '',
        disposition: normalizeDisposition(status, scriptGate),
      });
    }
  }

  return rows;
}

function summarizeDisposition(rules, tiered = false) {
  const byDisposition = { covered: 0, pending: 0, 'manual-review': 0, 'delete-candidate': 0, undisposed: 0 };
  for (const rule of rules) {
    byDisposition[rule.disposition] = (byDisposition[rule.disposition] ?? 0) + 1;
  }

  return {
    covered: byDisposition.covered,
    uncovered: rules.length - byDisposition.covered,
    disposed: rules.length - byDisposition.undisposed,
    undisposed: byDisposition.undisposed,
    byDisposition,
    ...(tiered ? { tiered: true } : {}),
  };
}

const slugify = (value) => value.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '') || 'cluster';
const makeCluster = (label, startLine, endLine, lines) => { const body = lines.join('\n'); return { id: slugify(label), label, startLine, endLine, body, hasRuleKeyword: findKind(body) !== null, softVerbDetected: SOFT_VERB_RE.test(body) }; };
function scanTranscripts(paths) {
  const bySource = {}, incidents = [];
  for (const source of paths.map((path) => path.trim()).filter(Boolean)) { const logPath = resolve(source, '.vibe/agent/session-log.md'); bySource[source] = { present: false, failure: 0, 'drift-observed': 0, decision: 0, 'audit-clear': 0 }; if (!existsSync(logPath)) { process.stderr.write(`[vibe-rule-audit] warning: scan target missing: ${source}\n`); continue; } bySource[source].present = true; readFileSync(logPath, 'utf8').split(/\r?\n/).forEach((text, index) => { const match = text.match(/^- \S+ .*\[(failure|drift-observed|decision|audit-clear)\]/); if (!match) return; const tag = match[1]; bySource[source][tag] += 1; incidents.push({ source, tag, line: index + 1, text }); }); }
  return { bySource, incidents };
}
function extractClusters(claudeContent) {
  const lines = claudeContent.split(/\r?\n/), starts = []; lines.forEach((line, index) => { const match = line.match(/^#{2,3}\s+(.+)$/); if (match) starts.push({ label: match[1], line: index + 1 }); });
  if (starts.length > 0) return starts.map((start, index) => { const endLine = (starts[index + 1]?.line ?? (lines.length + 1)) - 1; return makeCluster(start.label, start.line, endLine, lines.slice(start.line - 1, endLine).filter((line) => !/^<!-- (BEGIN|END):/.test(line))); }).filter((cluster) => cluster.hasRuleKeyword);
  const clusters = [];
  for (let index = 0; index < lines.length; index += 2) { const bodyLines = lines.slice(index, index + 2), cluster = makeCluster(`lines-${index + 1}-${index + bodyLines.length}`, index + 1, index + bodyLines.length, bodyLines); if (cluster.hasRuleKeyword) clusters.push(cluster); }
  return clusters;
}
function extractKeywords(clusterBody) {
  const found = []; for (const match of clusterBody.matchAll(/[A-Za-z가-힣0-9_-]{3,}/gu)) { const token = match[0].toLowerCase(); if (!STOPWORDS.has(token) && !found.includes(token)) found.push(token); if (found.length >= 12) break; } return found;
}
function matchEvidence(clusters, incidents) {
  const matched = new Map(); for (const cluster of clusters) { const keywords = extractKeywords(cluster.body), examples = []; for (const incident of incidents) { const line = incident.text.toLowerCase(); if (keywords.some((keyword) => line.includes(keyword))) { const snippet = incident.text.length > 160 ? `${incident.text.slice(0, 157)}...` : incident.text; if (!examples.some((hit) => hit.snippet === snippet)) examples.push({ source: incident.source, tag: incident.tag, snippet }); } } matched.set(cluster.id, examples); } return matched;
}
function classifyTier(cluster, evidenceCount, hasGapCoverage) {
  const hasScriptReference = /scripts\/vibe-[\w-]+\.mjs/.test(cluster.body);
  if (evidenceCount >= 3) return 'S';
  if (evidenceCount >= 1) return 'A';
  return hasGapCoverage || hasScriptReference ? 'B' : 'C';
}
function recommendedAction(tier, softVerbDetected) {
  const action = { S: 'keep-script', A: 'keep-md-only', B: 'delete-md', C: 'delete-md-and-script', unclassified: 'keep-md-only' }[tier] ?? 'keep-md-only'; return softVerbDetected && (tier === 'S' || tier === 'A') ? `${action} + should-to-must-tighten` : action;
}
function buildClusterAudit(claudeContent, gapsContent, transcriptCsv) {
  const gapRows = extractGapRows(gapsContent), sources = transcriptCsv.split(',').map((path) => path.trim()).filter(Boolean), { bySource, incidents } = scanTranscripts(sources), clusters = extractClusters(claudeContent), evidence = matchEvidence(clusters, incidents), byTier = { S: 0, A: 0, B: 0, C: 0, unclassified: 0 };
  const rules = clusters.map((cluster) => { const ids = Array.from(cluster.body.matchAll(/\bgap-[\w-]+\b/g), (match) => match[0]), disposedBy = ids.find((id) => gapRows.has(id)) ?? null, row = disposedBy === null ? null : gapRows.get(disposedBy), coveredBy = row?.disposition === 'covered' ? disposedBy : null, disposition = row?.disposition ?? 'undisposed', hits = evidence.get(cluster.id) ?? [], tier = classifyTier(cluster, hits.length, disposedBy !== null), keywords = extractKeywords(cluster.body); byTier[tier] += 1; return { line: cluster.startLine, text: cluster.label, kind: findKind(cluster.body) ?? 'MUST', covered: coveredBy !== null, coveredBy, disposed: disposition !== 'undisposed', disposedBy, disposition, cluster: { id: cluster.id, label: cluster.label, startLine: cluster.startLine, endLine: cluster.endLine, keywords, evidenceCount: hits.length, evidenceExamples: hits.slice(0, 3).map((hit) => hit.snippet), tier, recommendedAction: recommendedAction(tier, cluster.softVerbDetected), shouldToMustCandidate: cluster.softVerbDetected, tighteningSuggestion: cluster.softVerbDetected ? `trigger 조건을 ${keywords[0] ?? cluster.id} 포함 line 기준으로 tighten` : null, originalText: cluster.body } }; });
  return { summary: { total: rules.length, ...summarizeDisposition(rules, true), bySource, byTier, shouldToMustCandidates: rules.filter((rule) => rule.cluster.shouldToMustCandidate).length }, rules };
}

function buildAudit(claudeContent, gapsContent, options = {}) {
  if (options.scanTranscripts) return buildClusterAudit(claudeContent, gapsContent, options.scanTranscripts);
  const gapRows = extractGapRows(gapsContent);
  const rules = extractRules(claudeContent).map((rule) => {
    const ids = Array.from(rule.text.matchAll(/\bgap-[\w-]+\b/g), (match) => match[0]);
    const disposedBy = ids.find((id) => gapRows.has(id)) ?? null;
    const row = disposedBy === null ? null : gapRows.get(disposedBy);
    const disposition = row?.disposition ?? 'undisposed';
    const coveredBy = disposition === 'covered' ? disposedBy : null;
    return { ...rule, covered: coveredBy !== null, coveredBy, disposed: disposition !== 'undisposed', disposedBy, disposition };
  });
  return { summary: { total: rules.length, ...summarizeDisposition(rules) }, rules };
}

function readOptional(filePath) {
  try {
    return readFileSync(resolve(filePath), 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[vibe-rule-audit] warning: ${message}\n`);
    return '';
  }
}

function renderSection(title, rules, emptyText, renderDetail) {
  const lines = [`## ${title}`];
  if (rules.length === 0) {
    lines.push(emptyText);
    return lines;
  }

  for (const rule of rules) {
    lines.push(`- CLAUDE.md:${rule.line} [${rule.kind}] ${rule.text}`);
    lines.push(`  ${renderDetail(rule)}`);
  }

  return lines;
}

function renderText(audit) {
  const uncovered = audit.rules.filter((rule) => !rule.covered);
  const undisposed = audit.rules.filter((rule) => rule.disposition === 'undisposed');
  const covered = audit.rules.filter((rule) => rule.covered);
  const lines = [
    `# CLAUDE.md rule audit (${audit.summary.total} rules found; ${audit.summary.uncovered} uncovered; ${audit.summary.undisposed} undisposed)`,
    '',
    ...renderSection(
      'Undisposed (needs explicit coverage disposition)',
      undisposed,
      '(none)',
      () => 'hint: add a gap-* id with script-gate=covered|pending|manual-review|delete-candidate',
    ),
    '',
    ...renderSection(
      'Uncovered (candidates for next Sprint)',
      uncovered,
      '(none)',
      (rule) => rule.disposedBy === null ? 'hint: no matching gap-* id' : `disposition: ${rule.disposition} via ${rule.disposedBy}`,
    ),
    '',
    ...renderSection('Covered', covered, '(none)', (rule) => `covered-by: ${rule.coveredBy}`),
  ];
  if (audit.summary.tiered) {
    lines.push('', '## By tier (S/A/B/C)');
    for (const tier of ['S', 'A', 'B', 'C', 'unclassified']) lines.push(`- ${tier}: ${audit.summary.byTier[tier]}`);
  }
  lines.push('', '## By disposition');
  for (const disposition of ['covered', 'pending', 'manual-review', 'delete-candidate', 'undisposed']) {
    lines.push(`- ${disposition}: ${audit.summary.byDisposition[disposition] ?? 0}`);
  }

  return `${lines.join('\n')}\n`;
}

function cell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function emitReportMd(audit, outputPath) {
  const sources = Object.entries(audit.summary.bySource ?? {});
  const tierText = Object.entries(audit.summary.byTier ?? {}).map(([tier, count]) => `${tier}=${count}`).join(', ');
  const lines = ['# iter-3 rule audit report', '', `timestamp: ${new Date().toISOString()}`, 'tool version: scripts/vibe-rule-audit.mjs iter-3 N1', `sources: ${sources.map(([source]) => source).join(', ') || '(none)'}`, '', '| cluster_id | cluster_label | cluster_lines | evidence_count | evidence_examples | tier | recommended_action | should_to_must_candidate | tightening_suggestion |', '|---|---|---|---|---|---|---|---|---|'];
  for (const rule of audit.rules) {
    const c = rule.cluster;
    lines.push(`| ${cell(c.id)} | ${cell(c.label)} | ${c.startLine}-${c.endLine} | ${c.evidenceCount} | ${cell(c.evidenceExamples.join('<br>'))} | ${c.tier} | ${cell(c.recommendedAction)} | ${c.shouldToMustCandidate} | ${cell(c.tighteningSuggestion)} |`);
  }
  lines.push('', '## Summary', `total=${audit.summary.total}; byTier=${tierText}; sourcesScanned=${sources.length}; missingSources=${sources.filter(([, result]) => !result.present).length}`, '', '## Sources scanned');
  for (const [source, result] of sources) lines.push(`- ${source}: present=${result.present}; failure=${result.failure}; drift-observed=${result['drift-observed']}; decision=${result.decision}; audit-clear=${result['audit-clear']}`);
  lines.push('', '## Restoration protocol', 'dogfood8 post-acceptance 시 본 report + `rules-deleted.md` 를 함께 리뷰한다. 복원 필요 cluster 는 CLAUDE.md 에 재삽입 후 `.vibe/audit/iter-3/` 를 `rm -rf` 한다.');
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(resolve(outputPath), `${lines.join('\n')}\n`, 'utf8');
}

const options = parseArgs(process.argv);
const audit = buildAudit(readOptional(options.claudeMd), readOptional(options.gaps), options);
if (options.emitReportMd) emitReportMd(audit, options.emitReportMd);
if (options.format === 'json') {
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
} else {
  process.stdout.write(renderText(audit));
}
if (options.failOnUndisposed && audit.summary.undisposed > 0) {
  process.stderr.write(`[vibe-rule-audit] undisposed rules: ${audit.summary.undisposed}\n`);
  process.exitCode = 1;
}
