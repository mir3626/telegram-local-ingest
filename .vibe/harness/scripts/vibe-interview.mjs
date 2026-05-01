#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { resolveRoleFromCli } from './vibe-resolve-model.mjs';

/**
 * Interview session state shape:
 * {
 *   sessionId: string,
 *   createdAt: string,
 *   lang: "ko" | "en",
 *   maxRounds: number,
 *   oneLiner: string,
 *   inferredDomain: string | null,
 *   domainConfidence: number | null,
 *   adjacentDomains: string[],
 *   dimensions: Array<{ id: string, label: string, weight: number, subFields: string[], required: boolean }>,
 *   coverage: Record<string, { ratio: number, subFields: Record<string, { value: string, confidence: number, deferred: boolean }> }>,
 *   rounds: Array<{
 *     roundNumber: number,
 *     dimensionId: string,
 *     questions: string[],
 *     answer: string,
 *     attribution: unknown,
 *     crossDimensionSignals: Array<{ dimensionId: string, note: string }>,
 *     timestamp: string
 *   }>,
 *   ambiguityTrace: number[],
 *   terminatedAt: string | null,
 *   terminationReason: "ambiguity" | "max-rounds" | "soft-terminate" | null,
 *   outputPath: string,
 *   meta: { orchestratorModel: unknown | null },
 *   pending: {
 *     roundNumber: number,
 *     dimensionId: string,
 *     questions: string[],
 *     answer: string | null,
 *     synthesizerPrompt: string,
 *     answerParserPrompt: string | null
 *   } | null
 * }
 */

const ROOT = process.cwd();
const INTERVIEW_DIR = path.join(ROOT, '.vibe', 'interview-log');
const ACTIVE_POINTER_PATH = path.join(INTERVIEW_DIR, '.active');
const DIMENSIONS_PATH = path.join(ROOT, '.claude', 'skills', 'vibe-interview', 'dimensions.json');
const SYNTHESIZER_TEMPLATE_PATH = path.join(
  ROOT,
  '.claude',
  'skills',
  'vibe-interview',
  'prompts',
  'synthesizer.md',
);
const ANSWER_PARSER_TEMPLATE_PATH = path.join(
  ROOT,
  '.claude',
  'skills',
  'vibe-interview',
  'prompts',
  'answer-parser.md',
);
const DOMAIN_INFERENCE_TEMPLATE_PATH = path.join(
  ROOT,
  '.claude',
  'skills',
  'vibe-interview',
  'prompts',
  'domain-inference.md',
);
const DOMAIN_PROBE_MAP = [
  ['real-estate', 'real-estate.md'],
  ['부동산', 'real-estate.md'],
  ['행정사', 'real-estate.md'],
  ['lease', 'real-estate.md'],
  ['iot', 'iot.md'],
  ['mqtt', 'iot.md'],
  ['coap', 'iot.md'],
  ['device', 'iot.md'],
  ['data-pipeline', 'data-pipeline.md'],
  ['stream', 'data-pipeline.md'],
  ['etl', 'data-pipeline.md'],
  ['saas', 'web-saas.md'],
  ['multi-tenant', 'web-saas.md'],
  ['b2b software', 'web-saas.md'],
  ['game', 'game.md'],
  ['gaming', 'game.md'],
  ['matchmaking', 'game.md'],
  ['research', 'research.md'],
  ['scientific', 'research.md'],
  ['irb', 'research.md'],
  ['cli', 'cli-tool.md'],
  ['command-line', 'cli-tool.md'],
  ['terminal', 'cli-tool.md'],
];
const CROSS_DIMENSION_SIGNAL_CONFIDENCE = 0.25;
const REQUIRED_SOFT_TERMINATE_RATIO = 0.8;
const UNKNOWN_QUESTIONS_PLACEHOLDER =
  '[Questions were synthesized by the Orchestrator from the prior prompt; exact text was not echoed back to the engine.]';

let templateCache = null;

function usage() {
  return [
    'usage: node .vibe/harness/scripts/vibe-interview.mjs --init --prompt "<one-liner>" [--lang ko|en] [--max-rounds 30] [--mode init|iterate] [--carryover <iteration-id>] [--output <path>]',
    '   or: node .vibe/harness/scripts/vibe-interview.mjs --set-domain --domain "<string or json>"',
    '   or: node .vibe/harness/scripts/vibe-interview.mjs --continue --answer "<text>"',
    '   or: node .vibe/harness/scripts/vibe-interview.mjs --record --attribution \'<json>\'',
    '   or: node .vibe/harness/scripts/vibe-interview.mjs --status',
    '   or: node .vibe/harness/scripts/vibe-interview.mjs --abort',
    '   or: node .vibe/harness/scripts/vibe-interview.mjs --mode iterate --carryover <iteration-id> --dry-run',
  ].join('\n');
}

function exitWith(code, message) {
  if (message) {
    process.stderr.write(`${message}\n`);
  }
  process.exit(code);
}

function parseJsonText(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${message}`);
  }
}

function sanitizeInput(value) {
  return String(value ?? '').replaceAll('\u0000', '').trim();
}

function readIfExists(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}

function clampConfidence(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value < 0) {
    return 0;
  }

  if (value > 1) {
    return 1;
  }

  return value;
}

function ensureInterviewDir() {
  mkdirSync(INTERVIEW_DIR, { recursive: true });
}

function defaultSessionPath(sessionId) {
  return path.join(INTERVIEW_DIR, `${sessionId}.json`);
}

function sessionPathPointerPath(sessionId) {
  return path.join(INTERVIEW_DIR, `${sessionId}.path`);
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
  return parseJsonText(readFileSync(filePath, 'utf8'), filePath);
}

function createSessionId() {
  const iso = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const suffix = randomBytes(4).toString('hex').slice(0, 6);
  return `${iso}-${suffix}`;
}

function parseArgs(argv) {
  const flags = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) {
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      flags.set(token, next);
      index += 1;
      continue;
    }

    flags.set(token, true);
  }

  return flags;
}

function activePointerExists() {
  return existsSync(ACTIVE_POINTER_PATH);
}

function setActivePointer(sessionId, outputPath) {
  ensureInterviewDir();
  writeFileSync(ACTIVE_POINTER_PATH, `${sessionId}\n`, 'utf8');
  const resolvedOutputPath = path.resolve(outputPath);
  if (resolvedOutputPath !== defaultSessionPath(sessionId)) {
    writeFileSync(sessionPathPointerPath(sessionId), `${resolvedOutputPath}\n`, 'utf8');
  } else if (existsSync(sessionPathPointerPath(sessionId))) {
    unlinkSync(sessionPathPointerPath(sessionId));
  }
}

function clearActivePointer(sessionId) {
  if (existsSync(ACTIVE_POINTER_PATH)) {
    unlinkSync(ACTIVE_POINTER_PATH);
  }

  const pointerPath = sessionPathPointerPath(sessionId);
  if (existsSync(pointerPath)) {
    unlinkSync(pointerPath);
  }
}

function resolveActiveSessionPath() {
  if (!existsSync(ACTIVE_POINTER_PATH)) {
    exitWith(2, 'no active interview session (run --init first)');
  }

  const sessionId = sanitizeInput(readFileSync(ACTIVE_POINTER_PATH, 'utf8'));
  if (sessionId === '') {
    exitWith(2, 'no active interview session (run --init first)');
  }

  const pointerPath = sessionPathPointerPath(sessionId);
  const outputPath = existsSync(pointerPath)
    ? sanitizeInput(readFileSync(pointerPath, 'utf8'))
    : defaultSessionPath(sessionId);

  if (!existsSync(outputPath)) {
    exitWith(2, `active interview state is missing: ${outputPath}`);
  }

  return { sessionId, outputPath };
}

function loadSessionFromActivePointer() {
  const { outputPath } = resolveActiveSessionPath();
  const state = readJson(outputPath);
  return { outputPath, state };
}

function saveSession(state) {
  writeJson(state.outputPath, state);
}

function loadTemplates() {
  if (templateCache) {
    return templateCache;
  }

  try {
    templateCache = {
      synthesizer: readFileSync(SYNTHESIZER_TEMPLATE_PATH, 'utf8'),
      answerParser: readFileSync(ANSWER_PARSER_TEMPLATE_PATH, 'utf8'),
      domainInference: readFileSync(DOMAIN_INFERENCE_TEMPLATE_PATH, 'utf8'),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to load interview prompt templates: ${message}`);
  }

  return templateCache;
}

function validateDimensionsDocument(document) {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return 'root must be an object';
  }

  if (document.schemaVersion !== 1) {
    return 'schemaVersion must be 1';
  }

  if (!Array.isArray(document.dimensions) || document.dimensions.length < 8) {
    return 'dimensions must be an array with at least 8 items';
  }

  const seenIds = new Set();
  for (const dimension of document.dimensions) {
    if (typeof dimension !== 'object' || dimension === null || Array.isArray(dimension)) {
      return 'each dimension must be an object';
    }

    const keys = Object.keys(dimension).sort();
    const expectedKeys = ['id', 'label', 'required', 'subFields', 'weight'];
    if (keys.join(',') !== expectedKeys.join(',')) {
      return `dimension keys must be exactly ${expectedKeys.join(', ')}`;
    }

    if (typeof dimension.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(dimension.id)) {
      return `dimension id "${String(dimension.id)}" must be slug-like`;
    }

    if (seenIds.has(dimension.id)) {
      return `duplicate dimension id "${dimension.id}"`;
    }
    seenIds.add(dimension.id);

    if (typeof dimension.label !== 'string' || dimension.label.trim() === '') {
      return `dimension "${dimension.id}" label must be a non-empty string`;
    }

    if (typeof dimension.weight !== 'number' || dimension.weight < 0 || dimension.weight > 1) {
      return `dimension "${dimension.id}" weight must be between 0 and 1`;
    }

    if (
      !Array.isArray(dimension.subFields) ||
      !dimension.subFields.every((value) => typeof value === 'string')
    ) {
      return `dimension "${dimension.id}" subFields must be an array of strings`;
    }

    if (typeof dimension.required !== 'boolean') {
      return `dimension "${dimension.id}" required must be a boolean`;
    }
  }

  return null;
}

function loadDimensionsDocument() {
  if (!existsSync(DIMENSIONS_PATH)) {
    throw new Error(`missing .claude/skills/vibe-interview/dimensions.json at ${DIMENSIONS_PATH}`);
  }

  const document = readJson(DIMENSIONS_PATH);
  const validationError = validateDimensionsDocument(document);
  if (validationError) {
    throw new Error(
      `invalid .claude/skills/vibe-interview/dimensions.json: ${validationError}`,
    );
  }

  return document;
}

function createInitialCoverage(dimensions) {
  return Object.fromEntries(
    dimensions.map((dimension) => [
      dimension.id,
      {
        ratio: 0,
        subFields: Object.fromEntries(
          dimension.subFields.map((subFieldId) => [
            subFieldId,
            { value: '', confidence: 0, deferred: false },
          ]),
        ),
      },
    ]),
  );
}

// CROSS-REF (src/lib/interview.ts:subFieldCoverageValue)
// Inline port because .mjs stays build-free and cannot import .ts here.
function subFieldCoverageValue(subFieldCoverage) {
  return subFieldCoverage.deferred ? 0 : clampConfidence(subFieldCoverage.confidence);
}

// CROSS-REF (src/lib/interview.ts:dimensionCoverageRatio)
// Keep this logic in lockstep with the test-only typed helper.
function dimensionCoverageRatio(spec, dimensionCoverage) {
  if (spec.subFields.length === 0) {
    const freeForm = dimensionCoverage?.subFields?.free_form;
    if (!freeForm || freeForm.deferred || sanitizeInput(freeForm.value) === '') {
      return 0;
    }

    return 1;
  }

  const total = spec.subFields.reduce((sum, subFieldId) => {
    const subField = dimensionCoverage?.subFields?.[subFieldId];
    return sum + (subField ? subFieldCoverageValue(subField) : 0);
  }, 0);

  return total / spec.subFields.length;
}

// CROSS-REF (src/lib/interview.ts:computeAmbiguity)
// Drift is covered by test/interview-engine.test.ts via --stub-compute-ambiguity.
export function computeAmbiguity(dimensions, coverage) {
  const totalWeight = dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
  if (totalWeight <= 0) {
    return 1;
  }

  const weightedCoverage = dimensions.reduce((sum, dimension) => {
    const dimensionCoverage = coverage[dimension.id] ?? { ratio: 0, subFields: {} };
    return sum + dimension.weight * dimensionCoverageRatio(dimension, dimensionCoverage);
  }, 0);

  return 1 - weightedCoverage / totalWeight;
}

function sortByCoverageThenWeight(dimensions, coverage) {
  return [...dimensions].sort((left, right) => {
    const leftRatio = dimensionCoverageRatio(left, coverage[left.id] ?? { ratio: 0, subFields: {} });
    const rightRatio = dimensionCoverageRatio(right, coverage[right.id] ?? { ratio: 0, subFields: {} });

    if (leftRatio !== rightRatio) {
      return leftRatio - rightRatio;
    }

    if (left.weight !== right.weight) {
      return right.weight - left.weight;
    }

    return left.id.localeCompare(right.id);
  });
}

function sortByWeightThenCoverage(dimensions, coverage) {
  return [...dimensions].sort((left, right) => {
    if (left.weight !== right.weight) {
      return right.weight - left.weight;
    }

    const leftRatio = dimensionCoverageRatio(left, coverage[left.id] ?? { ratio: 0, subFields: {} });
    const rightRatio = dimensionCoverageRatio(right, coverage[right.id] ?? { ratio: 0, subFields: {} });
    if (leftRatio !== rightRatio) {
      return leftRatio - rightRatio;
    }

    return left.id.localeCompare(right.id);
  });
}

// CROSS-REF (src/lib/interview.ts:selectNextDimension)
// Keep candidate ordering and thrash avoidance aligned with the typed helper.
function selectNextDimension(dimensions, coverage, recentDimensionIds, options = {}) {
  const thrashWindow = options.thrashWindow ?? 3;
  const recent = new Set(recentDimensionIds.slice(-thrashWindow));
  const requiredCandidates = sortByCoverageThenWeight(
    dimensions.filter((dimension) => dimension.required),
    coverage,
  );
  const pendingRequired = requiredCandidates.filter((dimension) => {
    const ratio = dimensionCoverageRatio(
      dimension,
      coverage[dimension.id] ?? { ratio: 0, subFields: {} },
    );
    return ratio < 0.5;
  });
  const pool =
    pendingRequired.length > 0
      ? pendingRequired
      : sortByWeightThenCoverage(
          dimensions.filter((dimension) => {
            const ratio = dimensionCoverageRatio(
              dimension,
              coverage[dimension.id] ?? { ratio: 0, subFields: {} },
            );
            return ratio < 0.5;
          }),
          coverage,
        );

  if (pool.length === 0) {
    return sortByCoverageThenWeight(dimensions, coverage)[0] ?? dimensions[0] ?? null;
  }

  if (!recent.has(pool[0].id)) {
    return pool[0];
  }

  return pool.find((dimension) => !recent.has(dimension.id)) ?? pool[0];
}

function allRequiredDimensionsCovered(dimensions, coverage) {
  return dimensions
    .filter((dimension) => dimension.required)
    .every((dimension) => {
      const ratio = dimensionCoverageRatio(
        dimension,
        coverage[dimension.id] ?? { ratio: 0, subFields: {} },
      );
      return ratio >= REQUIRED_SOFT_TERMINATE_RATIO;
    });
}

// CROSS-REF (src/lib/interview.ts:shouldTerminate)
// Keep termination thresholds aligned with the typed helper.
function shouldTerminate(ambiguity, round, maxRounds, dimensions, coverage) {
  if (round > maxRounds) {
    return { terminate: true, reason: 'max-rounds' };
  }

  if (ambiguity <= 0.2) {
    return { terminate: true, reason: 'ambiguity' };
  }

  if (allRequiredDimensionsCovered(dimensions, coverage) && ambiguity <= 0.3) {
    return { terminate: true, reason: 'soft-terminate' };
  }

  return { terminate: false, reason: null };
}

function refreshCoverageRatios(state) {
  for (const dimension of state.dimensions) {
    const dimensionCoverage = state.coverage[dimension.id] ?? { ratio: 0, subFields: {} };
    dimensionCoverage.ratio = dimensionCoverageRatio(dimension, dimensionCoverage);
    state.coverage[dimension.id] = dimensionCoverage;
  }
}

function coverageSnapshot(state) {
  refreshCoverageRatios(state);
  return Object.fromEntries(
    state.dimensions.map((dimension) => [dimension.id, state.coverage[dimension.id]?.ratio ?? 0]),
  );
}

function pendingSubFieldsForDimension(state, dimension) {
  const dimensionCoverage = state.coverage[dimension.id] ?? { ratio: 0, subFields: {} };
  if (dimension.subFields.length === 0) {
    const freeForm = dimensionCoverage.subFields.free_form;
    return freeForm && sanitizeInput(freeForm.value) !== '' ? [] : ['free_form'];
  }

  return dimension.subFields.filter((subFieldId) => {
    const subField = dimensionCoverage.subFields[subFieldId];
    return !subField || subFieldCoverageValue(subField) < 1;
  });
}

function pendingDimensionSnapshot(state) {
  if (!state.pending) {
    return null;
  }

  const dimension = state.dimensions.find((candidate) => candidate.id === state.pending.dimensionId);
  if (!dimension) {
    return null;
  }

  return {
    id: dimension.id,
    label: dimension.label,
    subFields: dimension.subFields,
    pendingSubFields: pendingSubFieldsForDimension(state, dimension),
  };
}

function renderTemplate(template, replacements) {
  return Object.entries(replacements).reduce(
    (output, [token, value]) => output.replaceAll(token, String(value)),
    template,
  );
}

function summarizePriorAnswers(state) {
  if (state.rounds.length === 0) {
    return 'No prior answers yet.';
  }

  const lines = state.rounds.slice(-10).map((round) => {
    const answer = sanitizeInput(round.answer).slice(0, 180);
    return `Round ${round.roundNumber} [${round.dimensionId}] A: ${answer || '(empty)'}`;
  });
  return lines.join('\n');
}

function summarizeRecentSessionLog(limit = 20) {
  return readIfExists(path.join(ROOT, '.vibe', 'agent', 'session-log.md'))
    .split(/\r?\n/)
    .filter((line) => line.startsWith('- '))
    .slice(0, limit)
    .join('\n');
}

function buildPriorIterationCarryover(carryoverId) {
  const report = readIfExists(path.join(ROOT, 'docs', 'reports', 'project-report.html'));
  const handoff = readIfExists(path.join(ROOT, '.vibe', 'agent', 'handoff.md'));
  const milestones = readIfExists(path.join(ROOT, 'docs', 'plans', 'project-milestones.md'));
  const roadmap = readIfExists(path.join(ROOT, 'docs', 'plans', 'sprint-roadmap.md'));
  const historyRaw = readIfExists(path.join(ROOT, '.vibe', 'agent', 'iteration-history.json'));
  const snippets = [
    `Carryover iteration: ${carryoverId || '(unspecified)'}`,
    '',
    'Recent session entries:',
    summarizeRecentSessionLog() || '(none)',
    '',
    'Handoff snapshot:',
    handoff.split(/\r?\n/).slice(0, 24).join('\n') || '(missing)',
    '',
    'Milestones:',
    milestones.split(/\r?\n/).slice(0, 24).join('\n') || '(missing)',
    '',
    'Roadmap pointer:',
    roadmap.split(/\r?\n/).slice(0, 16).join('\n') || '(missing)',
    '',
    'Iteration history:',
    historyRaw.slice(0, 2000) || '(missing)',
    '',
    'Prior report text signals:',
    report.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000) || '(missing)',
  ];

  return ['## Prior iteration carryover', '', ...snippets].join('\n');
}

function resolveDomainProbeText(inferredDomain) {
  const haystack = inferredDomain.toLowerCase();
  for (const [needle, fileName] of DOMAIN_PROBE_MAP) {
    if (!haystack.includes(needle)) {
      continue;
    }

    const probePath = path.join(
      ROOT,
      '.claude',
      'skills',
      'vibe-interview',
      'domain-probes',
      fileName,
    );
    if (existsSync(probePath)) {
      return readFileSync(probePath, 'utf8');
    }
  }

  return '';
}

function buildDomainInferencePrompt(oneLiner, lang) {
  const { domainInference } = loadTemplates();
  return renderTemplate(domainInference, {
    '{{ONE_LINER}}': sanitizeInput(oneLiner),
    '{{LANG}}': lang,
  });
}

function buildSynthesizerPrompt(state, dimension, roundNumber) {
  const { synthesizer } = loadTemplates();
  const basePrompt = renderTemplate(synthesizer, {
    '{{ONE_LINER}}': sanitizeInput(state.oneLiner),
    '{{INFERRED_DOMAIN}}': sanitizeInput(state.inferredDomain ?? ''),
    '{{LANG}}': state.lang,
    '{{DIMENSION_ID}}': dimension.id,
    '{{DIMENSION_LABEL}}': dimension.label,
    '{{DIMENSION_WEIGHT}}': String(dimension.weight),
    '{{DIMENSION_SUBFIELDS}}': JSON.stringify(dimension.subFields),
    '{{PRIOR_ANSWERS_SUMMARY}}': summarizePriorAnswers(state),
    '{{COVERAGE_SNAPSHOT}}': JSON.stringify(coverageSnapshot(state)),
    '{{ROUND_NUMBER}}': String(roundNumber),
    '{{MAX_ROUNDS}}': String(state.maxRounds),
    '{{DOMAIN_PROBES}}': resolveDomainProbeText(state.inferredDomain ?? ''),
  });
  const carryover =
    state.meta?.interviewMode === 'iterate'
      ? sanitizeInput(state.meta?.priorIterationCarryover ?? '')
      : '';

  return carryover === '' ? basePrompt : `${basePrompt}\n\n${carryover}\n`;
}

function buildAnswerParserPrompt(state, dimension, pendingRound, answer) {
  const { answerParser } = loadTemplates();
  return renderTemplate(answerParser, {
    '{{DIMENSION_ID}}': dimension.id,
    '{{DIMENSION_LABEL}}': dimension.label,
    '{{SUBFIELDS_JSON}}': JSON.stringify(dimension.subFields),
    '{{LAST_QUESTIONS}}': JSON.stringify(
      pendingRound.questions.length > 0 ? pendingRound.questions : [UNKNOWN_QUESTIONS_PLACEHOLDER],
    ),
    '{{USER_ANSWER}}': sanitizeInput(answer),
    '{{LANG}}': state.lang,
  });
}

function createPendingRound(state) {
  const recentDimensionIds = state.rounds.slice(-3).map((round) => round.dimensionId);
  const dimension = selectNextDimension(state.dimensions, state.coverage, recentDimensionIds, {
    thrashWindow: 3,
  });

  if (!dimension) {
    throw new Error('unable to select next interview dimension');
  }

  const roundNumber = state.rounds.length + 1;
  const synthesizerPrompt = buildSynthesizerPrompt(state, dimension, roundNumber);
  state.pending = {
    roundNumber,
    dimensionId: dimension.id,
    questions: [UNKNOWN_QUESTIONS_PLACEHOLDER],
    answer: null,
    synthesizerPrompt,
    answerParserPrompt: null,
  };

  return {
    phase: 'round',
    roundNumber,
    dimension,
    synthesizerPrompt,
    priorCoverage: coverageSnapshot(state),
  };
}

function normalizeAttributionRecord(record) {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new Error('attribution payload must be an object');
  }

  const attribution =
    typeof record.attribution === 'object' && record.attribution !== null ? record.attribution : {};
  const crossDimensionSignals = Array.isArray(record.cross_dimension_signals)
    ? record.cross_dimension_signals
        .filter((signal) => typeof signal === 'object' && signal !== null)
        .slice(0, 3)
        .map((signal) => ({
          dimensionId: sanitizeInput(signal.dimensionId),
          note: sanitizeInput(signal.note),
        }))
        .filter((signal) => signal.dimensionId !== '' && signal.note !== '')
    : [];
  const rationale = sanitizeInput(record.rationale ?? '');

  return {
    attribution,
    crossDimensionSignals,
    rationale,
    raw: record,
  };
}

function ensureDimensionCoverageSlot(state, dimensionId) {
  const dimension = state.dimensions.find((candidate) => candidate.id === dimensionId);
  if (!dimension) {
    return null;
  }

  if (!state.coverage[dimensionId]) {
    state.coverage[dimensionId] = { ratio: 0, subFields: {} };
  }

  return dimension;
}

function mergeSubFieldCoverage(existing, incoming) {
  const deferred = Boolean(incoming.deferred);
  if (deferred) {
    return { value: '', confidence: 0, deferred: true };
  }

  const next = {
    value: sanitizeInput(incoming.value ?? ''),
    confidence: clampConfidence(Number(incoming.confidence ?? 0)),
    deferred: false,
  };

  if (!existing || next.confidence >= clampConfidence(Number(existing.confidence ?? 0))) {
    return next;
  }

  return existing;
}

function applyAttributionToDimension(state, dimension, attributionMap) {
  const dimensionCoverage = state.coverage[dimension.id] ?? { ratio: 0, subFields: {} };
  if (dimension.subFields.length === 0) {
    const freeForm = attributionMap.free_form;
    if (typeof freeForm === 'object' && freeForm !== null) {
      dimensionCoverage.subFields.free_form = mergeSubFieldCoverage(
        dimensionCoverage.subFields.free_form,
        freeForm,
      );
    }
  } else {
    for (const subFieldId of dimension.subFields) {
      const incoming = attributionMap[subFieldId];
      if (typeof incoming !== 'object' || incoming === null) {
        continue;
      }

      dimensionCoverage.subFields[subFieldId] = mergeSubFieldCoverage(
        dimensionCoverage.subFields[subFieldId],
        incoming,
      );
    }
  }

  dimensionCoverage.ratio = dimensionCoverageRatio(dimension, dimensionCoverage);
  state.coverage[dimension.id] = dimensionCoverage;
}

function applyCrossDimensionSignals(state, signals) {
  for (const signal of signals) {
    const dimension = ensureDimensionCoverageSlot(state, signal.dimensionId);
    if (!dimension) {
      continue;
    }

    const dimensionCoverage = state.coverage[dimension.id];
    if (dimension.subFields.length === 0) {
      dimensionCoverage.subFields.free_form = mergeSubFieldCoverage(
        dimensionCoverage.subFields.free_form,
        {
          value: signal.note,
          confidence: CROSS_DIMENSION_SIGNAL_CONFIDENCE,
          deferred: false,
        },
      );
    } else {
      const targetSubFieldId =
        dimension.subFields.find((subFieldId) => {
          const current = dimensionCoverage.subFields[subFieldId];
          return !current || current.value.trim() === '';
        }) ?? dimension.subFields[0];

      if (targetSubFieldId) {
        dimensionCoverage.subFields[targetSubFieldId] = mergeSubFieldCoverage(
          dimensionCoverage.subFields[targetSubFieldId],
          {
            value: signal.note,
            confidence: CROSS_DIMENSION_SIGNAL_CONFIDENCE,
            deferred: false,
          },
        );
      }
    }

    dimensionCoverage.ratio = dimensionCoverageRatio(dimension, dimensionCoverage);
  }
}

function parseDomainPayload(rawDomain) {
  const trimmed = sanitizeInput(rawDomain);
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const parsed = parseJsonText(trimmed, 'domain payload');
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.inferred_domain === 'string') {
      return {
        inferredDomain: sanitizeInput(parsed.inferred_domain),
        domainConfidence:
          typeof parsed.confidence === 'number' ? clampConfidence(parsed.confidence) : null,
        adjacentDomains: Array.isArray(parsed.adjacent_domains)
          ? parsed.adjacent_domains.map((value) => sanitizeInput(value)).filter(Boolean)
          : [],
      };
    }
  }

  return {
    inferredDomain: trimmed,
    domainConfidence: null,
    adjacentDomains: [],
  };
}

function buildDimensionSummary(state) {
  return state.dimensions.map((dimension) => {
    const dimensionCoverage = state.coverage[dimension.id] ?? { ratio: 0, subFields: {} };
    if (dimension.subFields.length === 0) {
      const freeForm = dimensionCoverage.subFields.free_form;
      return {
        id: dimension.id,
        label: dimension.label,
        ratio: dimensionCoverage.ratio ?? 0,
        details: freeForm?.value ? [freeForm.value] : [],
      };
    }

    return {
      id: dimension.id,
      label: dimension.label,
      ratio: dimensionCoverage.ratio ?? 0,
      details: dimension.subFields
        .map((subFieldId) => {
          const subField = dimensionCoverage.subFields[subFieldId];
          if (!subField || sanitizeInput(subField.value) === '') {
            return null;
          }

          const suffix = subField.deferred ? ' (deferred)' : '';
          return `${subFieldId}: ${subField.value}${suffix}`;
        })
        .filter(Boolean),
    };
  });
}

function listDeferredSubFields(state) {
  const deferred = [];
  for (const dimension of state.dimensions) {
    const dimensionCoverage = state.coverage[dimension.id] ?? { ratio: 0, subFields: {} };
    if (dimension.subFields.length === 0) {
      const freeForm = dimensionCoverage.subFields.free_form;
      if (freeForm?.deferred) {
        deferred.push(`${dimension.id}.free_form`);
      }
      continue;
    }

    for (const subFieldId of dimension.subFields) {
      if (dimensionCoverage.subFields[subFieldId]?.deferred) {
        deferred.push(`${dimension.id}.${subFieldId}`);
      }
    }
  }
  return deferred;
}

function buildSeedForProductMd(state, ambiguityFinal) {
  const summaryLines = buildDimensionSummary(state)
    .map((dimension) => {
      const detailText =
        dimension.details.length > 0 ? dimension.details.join('; ') : '(unanswered)';
      return `- **${dimension.label}**: ${detailText}`;
    })
    .join('\n');

  const deferred = listDeferredSubFields(state);
  const transcript = state.rounds
    .map((round) => {
      const questionText =
        round.questions.length > 0 ? round.questions.join(' / ') : UNKNOWN_QUESTIONS_PLACEHOLDER;
      return `- Round ${round.roundNumber} (${round.dimensionId}): ${questionText} -> ${round.answer}`;
    })
    .join('\n');

  return [
    '## Phase 3 답변 기록 (native interview)',
    '',
    '### Dimension summary',
    summaryLines || '- none',
    '',
    '### Final ambiguity',
    `- ${ambiguityFinal.toFixed(4)}`,
    '',
    '### Deferred sub-fields',
    deferred.length > 0 ? deferred.map((entry) => `- ${entry}`).join('\n') : '- none',
    '',
    '### Q/A transcript',
    transcript || '- none',
  ].join('\n');
}

function createDonePayload(state, ambiguityFinal, terminationReason) {
  const dimensionSummary = buildDimensionSummary(state);
  const answers = state.rounds.map((round) => ({
    roundNumber: round.roundNumber,
    dimensionId: round.dimensionId,
    answer: round.answer,
  }));
  const rationale = `terminated via ${terminationReason} at round ${state.rounds.length}`;

  return {
    phase: 'done',
    summary: {
      ambiguity_final: ambiguityFinal,
      dimensions: dimensionSummary,
      answers,
      rationale,
    },
    seedForProductMd: buildSeedForProductMd(state, ambiguityFinal),
  };
}

function initCommand(flags) {
  if (activePointerExists()) {
    exitWith(2, 'existing active session; run --abort first');
  }

  const oneLiner = sanitizeInput(flags.get('--prompt'));
  if (oneLiner === '') {
    exitWith(2, '--prompt is required');
  }

  const lang = flags.get('--lang') === 'en' ? 'en' : 'ko';
  const mode = flags.get('--mode') === 'iterate' ? 'iterate' : 'init';
  const carryoverIterationId = sanitizeInput(flags.get('--carryover'));
  const defaultMaxRounds = mode === 'iterate' ? 15 : 30;
  const maxRoundsRaw = Number(flags.get('--max-rounds') ?? defaultMaxRounds);
  const maxRounds =
    Number.isFinite(maxRoundsRaw) && maxRoundsRaw > 0
      ? Math.floor(maxRoundsRaw)
      : defaultMaxRounds;
  const sessionId = createSessionId();

  let dimensionsDocument;
  try {
    dimensionsDocument = loadDimensionsDocument();
    loadTemplates();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitWith(3, message);
  }

  const outputPath = path.resolve(
    flags.get('--output') ? sanitizeInput(flags.get('--output')) : defaultSessionPath(sessionId),
  );
  const state = {
    sessionId,
    createdAt: new Date().toISOString(),
    lang,
    maxRounds,
    oneLiner,
    inferredDomain: null,
    domainConfidence: null,
    adjacentDomains: [],
    dimensions: dimensionsDocument.dimensions,
    coverage: createInitialCoverage(dimensionsDocument.dimensions),
    rounds: [],
    ambiguityTrace: [],
    terminatedAt: null,
    terminationReason: null,
    outputPath,
    meta: {
      orchestratorModel: null,
      interviewMode: mode,
      carryoverIterationId: mode === 'iterate' ? carryoverIterationId : null,
      priorIterationCarryover:
        mode === 'iterate' ? buildPriorIterationCarryover(carryoverIterationId) : '',
    },
    pending: null,
  };

  try {
    state.meta.orchestratorModel = resolveRoleFromCli('planner', { root: ROOT });
  } catch {
    state.meta.orchestratorModel = null;
  }

  ensureInterviewDir();
  saveSession(state);
  setActivePointer(sessionId, outputPath);

  process.stdout.write(
    `${JSON.stringify(
      {
        phase: 'domain-inference',
        inferencePrompt: buildDomainInferencePrompt(oneLiner, lang),
      },
      null,
      2,
    )}\n`,
  );
}

function setDomainCommand(flags) {
  const domainRaw = sanitizeInput(flags.get('--domain'));
  if (domainRaw === '') {
    exitWith(2, '--domain is required');
  }

  const { state } = loadSessionFromActivePointer();
  const domainPayload = parseDomainPayload(domainRaw);
  state.inferredDomain = domainPayload.inferredDomain;
  state.domainConfidence = domainPayload.domainConfidence;
  state.adjacentDomains = domainPayload.adjacentDomains;

  const payload = createPendingRound(state);
  saveSession(state);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function continueCommand(flags) {
  const answer = sanitizeInput(flags.get('--answer'));
  if (answer === '') {
    exitWith(2, '--answer is required');
  }

  const { state } = loadSessionFromActivePointer();
  if (!state.pending) {
    exitWith(2, 'no pending interview round (run --set-domain or complete --record first)');
  }

  const dimension = state.dimensions.find((candidate) => candidate.id === state.pending.dimensionId);
  if (!dimension) {
    exitWith(2, `pending dimension is unknown: ${state.pending.dimensionId}`);
  }

  state.pending.answer = answer;
  state.pending.answerParserPrompt = buildAnswerParserPrompt(state, dimension, state.pending, answer);
  saveSession(state);

  process.stdout.write(
    `${JSON.stringify(
      {
        phase: 'parse',
        answerParserPrompt: state.pending.answerParserPrompt,
        pendingDimensionId: state.pending.dimensionId,
      },
      null,
      2,
    )}\n`,
  );
}

function recordCommand(flags) {
  const rawAttribution = sanitizeInput(flags.get('--attribution'));
  if (rawAttribution === '') {
    exitWith(2, '--attribution is required');
  }

  const { state } = loadSessionFromActivePointer();
  if (!state.pending || state.pending.answer === null) {
    exitWith(2, 'no pending answer to record (run --continue first)');
  }

  const dimension = state.dimensions.find((candidate) => candidate.id === state.pending.dimensionId);
  if (!dimension) {
    exitWith(2, `pending dimension is unknown: ${state.pending.dimensionId}`);
  }

  let normalizedAttribution;
  try {
    normalizedAttribution = normalizeAttributionRecord(parseJsonText(rawAttribution, 'attribution'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitWith(2, message);
  }

  applyAttributionToDimension(state, dimension, normalizedAttribution.attribution);
  applyCrossDimensionSignals(state, normalizedAttribution.crossDimensionSignals);
  refreshCoverageRatios(state);

  state.rounds.push({
    roundNumber: state.pending.roundNumber,
    dimensionId: state.pending.dimensionId,
    questions: state.pending.questions,
    answer: state.pending.answer,
    attribution: normalizedAttribution.raw,
    crossDimensionSignals: normalizedAttribution.crossDimensionSignals,
    timestamp: new Date().toISOString(),
  });

  const ambiguity = computeAmbiguity(state.dimensions, state.coverage);
  state.ambiguityTrace.push(ambiguity);
  state.pending = null;

  if (state.rounds.length > state.maxRounds * 0.8 && ambiguity > 0.4) {
    process.stderr.write(
      `[vibe-interview] rounds ${state.rounds.length}/${state.maxRounds} and ambiguity ${ambiguity.toFixed(3)} remain high; consider PO-proxy finalization.\n`,
    );
  }

  const termination = shouldTerminate(
    ambiguity,
    state.rounds.length,
    state.maxRounds,
    state.dimensions,
    state.coverage,
  );

  if (termination.terminate) {
    state.terminatedAt = new Date().toISOString();
    state.terminationReason = termination.reason;
    saveSession(state);
    clearActivePointer(state.sessionId);
    process.stdout.write(
      `${JSON.stringify(createDonePayload(state, ambiguity, termination.reason), null, 2)}\n`,
    );
    return;
  }

  const payload = createPendingRound(state);
  saveSession(state);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function statusCommand() {
  const { outputPath, state } = loadSessionFromActivePointer();
  refreshCoverageRatios(state);
  process.stdout.write(
    `${JSON.stringify(
      {
        sessionId: state.sessionId,
        outputPath,
        lang: state.lang,
        inferredDomain: state.inferredDomain,
        rounds: state.rounds.length,
        pendingDimensionId: state.pending?.dimensionId ?? null,
        pendingDimension: pendingDimensionSnapshot(state),
        ambiguity: computeAmbiguity(state.dimensions, state.coverage),
        coverage: coverageSnapshot(state),
      },
      null,
      2,
    )}\n`,
  );
}

function abortCommand() {
  if (!activePointerExists()) {
    process.stdout.write(`${JSON.stringify({ phase: 'aborted', active: false }, null, 2)}\n`);
    return;
  }

  const { state } = loadSessionFromActivePointer();
  clearActivePointer(state.sessionId);
  if (existsSync(state.outputPath)) {
    rmSync(state.outputPath, { force: true });
  }

  process.stdout.write(
    `${JSON.stringify({ phase: 'aborted', active: false, sessionId: state.sessionId }, null, 2)}\n`,
  );
}

function stubComputeAmbiguityCommand(flags) {
  const rawCoverage = sanitizeInput(flags.get('--stub-compute-ambiguity'));
  if (rawCoverage === '') {
    exitWith(2, '--stub-compute-ambiguity requires a JSON payload');
  }

  let dimensionsDocument;
  try {
    dimensionsDocument = loadDimensionsDocument();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitWith(3, message);
  }

  const coverage = parseJsonText(rawCoverage, 'coverage fixture');
  process.stdout.write(`${computeAmbiguity(dimensionsDocument.dimensions, coverage)}\n`);
}

function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.has('--stub-compute-ambiguity')) {
    stubComputeAmbiguityCommand(flags);
    return;
  }

  if (flags.get('--mode') === 'iterate' && flags.has('--dry-run')) {
    const carryoverIterationId = sanitizeInput(flags.get('--carryover'));
    process.stdout.write(
      `${JSON.stringify(
        {
          phase: 'iterate-dry-run',
          mode: 'iterate',
          carryoverIterationId,
          maxRoundsDefault: 15,
          priorIterationCarryover: buildPriorIterationCarryover(carryoverIterationId),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  try {
    if (flags.has('--init')) {
      initCommand(flags);
      return;
    }

    if (flags.has('--set-domain')) {
      setDomainCommand(flags);
      return;
    }

    if (flags.has('--continue')) {
      continueCommand(flags);
      return;
    }

    if (flags.has('--record')) {
      recordCommand(flags);
      return;
    }

    if (flags.has('--status')) {
      statusCommand();
      return;
    }

    if (flags.has('--abort')) {
      abortCommand();
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitWith(2, message);
  }

  exitWith(2, usage());
}

const entryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entryHref) {
  main();
}
