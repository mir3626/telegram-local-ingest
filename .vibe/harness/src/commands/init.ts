import process from 'node:process';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { copyFile } from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { parseArgs, getStringFlag } from '../lib/args.js';
import { runMain } from '../lib/cli.js';
import { fileExists, readJson, readText, writeJson, writeText } from '../lib/fs.js';
import { logger } from '../lib/logger.js';
import { paths } from '../lib/paths.js';
import type { SprintRoleDefinition, VibeConfig } from '../lib/config.js';

export const AGENT_INIT_FLAG = '--from-agent-skill';
export const INIT_MODE_FLAG = '--mode';
const AGENT_INIT_ENV = 'VIBE_INIT_AGENT';
const AGENT_DELEGATION_MARKER = '## (이 아래부터가 실제 agent 에게 전달되는 prompt 본문이다)';
const AGENT_DELEGATION_END_MARKER = '## (Template 끝)';
const ONE_LINER_PLACEHOLDER = '<ONE_LINER>';
const RUNTIME_LABEL_PLACEHOLDER = '<AGENT_RUNTIME_LABEL>';
const RUNTIME_MEMORY_PLACEHOLDER = '<RUNTIME_MEMORY_STEPS>';
const RUNTIME_NOTES_PLACEHOLDER = '<RUNTIME_DELEGATION_NOTES>';

type InitMode = 'human' | 'agent';
type AgentRuntime = 'claude' | 'codex';

// ─── helpers ───────────────────────────────────────────────────────

function hr(): void {
  console.log('─'.repeat(60));
}

export function isAgentSkillInvocation(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const envValue = env[AGENT_INIT_ENV]?.toLowerCase();
  return argv.includes(AGENT_INIT_FLAG) || envValue === '1' || envValue === 'true';
}

export function renderDirectInitGuardMessage(): string {
  return [
    'vibe:init is an agent-skill bootstrap step, not a direct shell entrypoint.',
    '',
    'Start it from an agent session instead:',
    '  Claude Code: /vibe-init',
    '  Codex: ask Codex to run the vibe-init workflow using .codex/skills/vibe-init/SKILL.md',
    '',
    'Agent skills may run the mechanical bootstrap command as:',
    `  npm run vibe:init -- ${AGENT_INIT_FLAG} ${INIT_MODE_FLAG}=human`,
    '',
    'Direct shell execution stops here so the agent can complete product context, roadmap, handoff, and session-log setup.',
    '',
  ].join('\n');
}

export function renderMissingModeMessage(): string {
  return [
    'vibe:init requires an explicit session mode before bootstrap work can run.',
    '',
    'Agent skills must perform Step 1-0 first, then call one of:',
    `  npm run vibe:init -- ${AGENT_INIT_FLAG} ${INIT_MODE_FLAG}=human`,
    `  npm run vibe:init -- ${AGENT_INIT_FLAG} ${INIT_MODE_FLAG}=agent --runtime=codex --one-liner "<project one-liner>"`,
    '',
    'The agent path records .vibe/config.json.mode, prints the delegation prompt, and exits before Phase 1-1.',
    '',
  ].join('\n');
}

function parseInitMode(value: string | undefined): InitMode | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === 'human' || value === 'agent') {
    return value;
  }

  throw new Error(`Invalid init mode: ${value}. Expected "human" or "agent".`);
}

function parseAgentRuntime(value: string | undefined): AgentRuntime {
  if (value === undefined || value === 'claude') {
    return 'claude';
  }

  if (value === 'codex') {
    return 'codex';
  }

  throw new Error(`Invalid agent runtime: ${value}. Expected "claude" or "codex".`);
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function extractDelegationPromptBody(template: string): string {
  const markerIndex = template.indexOf(AGENT_DELEGATION_MARKER);
  if (markerIndex === -1) {
    throw new Error(`Agent delegation template is missing marker: ${AGENT_DELEGATION_MARKER}`);
  }

  const bodyStart = template.indexOf('\n', markerIndex);
  const bodyWithFooter = bodyStart === -1 ? '' : template.slice(bodyStart + 1);
  const endMarkerIndex = bodyWithFooter.indexOf(AGENT_DELEGATION_END_MARKER);
  return (endMarkerIndex === -1 ? bodyWithFooter : bodyWithFooter.slice(0, endMarkerIndex)).trim();
}

export function normalizeAgentOneLiner(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function runtimeMemorySteps(runtime: AgentRuntime): string {
  if (runtime === 'codex') {
    return [
      '1. `AGENTS.md` 의 `<!-- BEGIN:HARNESS:agent-memory --> ... <!-- END:HARNESS:agent-memory -->` 블록.',
      '   Codex role mode, initialization boundary, BLOCKED rule, and encoding integrity rule are authoritative.',
      '2. `docs/context/orchestration.md` 의 provider-neutral 역할/Phase 매트릭스.',
      '3. `docs/context/codex-execution.md` 의 provider-neutral lifecycle and Codex Windows execution rules.',
      '4. `CLAUDE.md` 의 `<!-- BEGIN:CHARTER -->` 와 `<!-- BEGIN:FREEZE-POSTURE -->` 블록은 shared nominal charter로 읽되,',
      '   Claude Code 전용 Agent/PreCompact mechanics는 Codex에서 그대로 가정하지 않는다.',
      '5. `.claude/skills/vibe-init/SKILL.md` 의 Phase 1~4 흐름 개요 (Step 1-0 은 이미 완료된 것으로 간주).',
    ].join('\n');
  }

  return [
    '1. `CLAUDE.md` 의 `<!-- BEGIN:CHARTER --> ... <!-- END:CHARTER -->` 블록 전체.',
    '2. `CLAUDE.md` 의 `<!-- BEGIN:FREEZE-POSTURE -->` 블록.',
    '3. `.claude/skills/vibe-init/SKILL.md` 의 Phase 1~4 흐름 개요 (Step 1-0 은 이미 완료된 것으로 간주).',
  ].join('\n');
}

function runtimeDelegationNotes(runtime: AgentRuntime): string {
  if (runtime === 'codex') {
    return [
      '- Codex로 실행 중이면 `AGENTS.md`의 Codex Orchestrator maintenance mode가 우선한다.',
      '- Claude Code의 native Agent/PreCompact 기능을 전제로 하지 말고, 사용 가능한 Codex 도구 또는 provider-neutral fallback으로 대체한다.',
      '- Sprint prompt가 Codex Generator로 투입되는 순간에는 다시 Generator 계약과 Files Generator may touch 경계를 따른다.',
    ].join('\n');
  }

  return [
    '- Claude Code로 실행 중이면 `CLAUDE.md`의 nominal Orchestrator 계약과 Agent 호출 메커니즘을 따른다.',
    '- Codex는 Sprint Generator로만 위임하고, Generator 호출은 `./.vibe/harness/scripts/run-codex.sh`를 경유한다.',
  ].join('\n');
}

export function renderAgentDelegationPromptBody(
  template: string,
  oneLiner: string,
  runtime: AgentRuntime,
): string {
  const body = extractDelegationPromptBody(template);
  const oneLinerCount = countOccurrences(body, ONE_LINER_PLACEHOLDER);

  if (oneLinerCount !== 1) {
    throw new Error(
      `Agent delegation prompt body must contain ${ONE_LINER_PLACEHOLDER} exactly once; found ${oneLinerCount}.`,
    );
  }

  return body
    .replace(ONE_LINER_PLACEHOLDER, normalizeAgentOneLiner(oneLiner))
    .replaceAll(RUNTIME_LABEL_PLACEHOLDER, runtime === 'codex' ? 'Codex Orchestrator' : 'Claude Code')
    .replaceAll(RUNTIME_MEMORY_PLACEHOLDER, runtimeMemorySteps(runtime))
    .replaceAll(RUNTIME_NOTES_PLACEHOLDER, runtimeDelegationNotes(runtime));
}

function formatAgentDelegationPrompt(renderedBody: string, runtime: AgentRuntime): string {
  const runtimeLabel = runtime === 'codex' ? 'Codex' : 'Claude Code';

  return [
    '─'.repeat(60),
    `Agent Delegation Prompt (copy into a new ${runtimeLabel} session)`,
    '─'.repeat(60),
    '',
    '```md',
    renderedBody,
    '```',
    '',
    '─'.repeat(60),
    '',
    `Copy the prompt above into a fresh ${runtimeLabel} session.`,
    'This /vibe-init session stops here.',
    '',
  ].join('\n');
}

function guardAgentSkillInvocation(): boolean {
  if (isAgentSkillInvocation()) {
    return true;
  }

  process.stderr.write(renderDirectInitGuardMessage());
  process.exitCode = 1;
  return false;
}

async function promptValue(
  rl: readline.Interface,
  label: string,
  fallback: string,
): Promise<string> {
  const answer = (await rl.question(`${label} [${fallback}]: `)).trim();
  return answer || fallback;
}

function formatSprintRoleFallback(value: SprintRoleDefinition | undefined, fallback: string): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value && typeof value.provider === 'string' && typeof value.tier === 'string') {
    return `${value.provider}:${value.tier}`;
  }

  return fallback;
}

async function ask(rl: readline.Interface, question: string): Promise<string> {
  const answer = (await rl.question(question)).trim();
  return answer;
}

async function askYesNo(rl: readline.Interface, question: string): Promise<boolean> {
  const answer = (await rl.question(`${question} (y/n): `)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes' || answer === 'ㅛ';
}

async function askMultiLine(rl: readline.Interface, question: string): Promise<string[]> {
  console.log(question);
  console.log('  (한 줄에 하나씩 입력, 빈 줄 입력하면 완료)');
  const lines: string[] = [];
  while (true) {
    const line = (await rl.question('  > ')).trim();
    if (line === '') break;
    lines.push(line);
  }
  return lines;
}

// ─── .env setup ────────────────────────────────────────────────────

async function ensureEnvFile(): Promise<void> {
  if (await fileExists(paths.envFile)) {
    logger.info('.env already exists');
    return;
  }
  if (!(await fileExists(paths.envExample))) {
    logger.info('.env.example not found, skipping .env creation');
    return;
  }
  await copyFile(paths.envExample, paths.envFile);
  logger.info('created .env from .env.example — fill in any API keys you need');
}

async function ensureUpstreamConfig(): Promise<void> {
  const candidates = [
    path.join(paths.root, '.vibe', 'harness', 'scripts', 'vibe-version-check.mjs'),
    path.join(paths.root, 'scripts', 'vibe-version-check.mjs'),
  ];
  let scriptPath: string | undefined;

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      scriptPath = candidate;
      break;
    }
  }

  if (!scriptPath) {
    return;
  }

  spawnSync(process.execPath, [scriptPath, '--ensure-upstream-only'], {
    cwd: paths.root,
    env: { ...process.env, VIBE_ROOT: paths.root },
    stdio: 'ignore',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTemplateAgentState(value: unknown): boolean {
  if (path.basename(paths.root).toLowerCase() === 'vibe-doctor') {
    return false;
  }
  if (!isRecord(value) || !isRecord(value.project)) {
    return false;
  }
  return value.project.name === 'vibe-doctor';
}

function initialSprintStatus(nowIso: string): Record<string, unknown> {
  return {
    $schema: './sprint-status.schema.json',
    schemaVersion: '0.1',
    project: {
      name: path.basename(paths.root),
      createdAt: nowIso,
      runtime: 'node24',
    },
    sprints: [],
    verificationCommands: [],
    handoff: {
      currentSprintId: 'idle',
      lastActionSummary: 'Initialized project state; run /vibe-init to complete product context and roadmap setup.',
      orchestratorContextBudget: 'medium',
      preferencesActive: [],
      handoffDocPath: '.vibe/agent/handoff.md',
      updatedAt: nowIso,
    },
    pendingRisks: [],
    lastSprintScope: [],
    lastSprintScopeGlob: [],
    sprintsSinceLastAudit: 0,
    stateUpdatedAt: nowIso,
    verifiedAt: null,
  };
}

async function ensureInitialAgentState(): Promise<void> {
  const statusPath = path.join(paths.root, '.vibe', 'agent', 'sprint-status.json');
  const nowIso = new Date().toISOString();
  let shouldWrite = !(await fileExists(statusPath));

  if (!shouldWrite) {
    try {
      shouldWrite = isTemplateAgentState(await readJson<unknown>(statusPath));
    } catch {
      shouldWrite = true;
    }
  }

  if (!shouldWrite) {
    return;
  }

  await writeJson(statusPath, initialSprintStatus(nowIso));
  await writeText(
    path.join(paths.root, '.vibe', 'agent', 'handoff.md'),
    [
      '# Orchestrator Handoff',
      '',
      '## 1. Identity',
      '',
      `- repo: \`${path.basename(paths.root)}\``,
      '- status: initialized',
      '',
      '## 2. Status',
      '',
      'IDLE - run /vibe-init to complete project context and roadmap setup.',
      '',
    ].join('\n'),
  );
  await writeText(
    path.join(paths.root, '.vibe', 'agent', 'session-log.md'),
    [
      '# Session Log',
      '',
      '## Entries',
      `- ${nowIso} [decision][vibe-init-state] initialized empty sprint state`,
      '',
    ].join('\n'),
  );
  logger.info('initialized .vibe/agent state with empty sprint history');
}

async function recordSharedConfigMode(mode: InitMode): Promise<void> {
  if (!(await fileExists(paths.sharedConfig))) {
    throw new Error(`Missing ${path.relative(paths.root, paths.sharedConfig)}; cannot record init mode.`);
  }

  const config = await readJson<Record<string, unknown>>(paths.sharedConfig);
  config.mode = mode;
  await writeJson(paths.sharedConfig, config);
}

async function promptInitMode(interactive: boolean): Promise<InitMode | null> {
  if (!interactive) {
    process.stderr.write(renderMissingModeMessage());
    process.exitCode = 1;
    return null;
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = (
      await rl.question('vibe-init mode? [human] (choices: human, agent): ')
    ).trim().toLowerCase();
    return parseInitMode(answer || 'human') ?? 'human';
  } finally {
    rl.close();
  }
}

async function resolveOneLiner(value: string | undefined, interactive: boolean): Promise<string | null> {
  if (value && normalizeAgentOneLiner(value)) {
    return normalizeAgentOneLiner(value);
  }

  if (!interactive) {
    process.stderr.write('vibe:init --mode=agent requires --one-liner "<project one-liner>".\n');
    process.exitCode = 1;
    return null;
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = normalizeAgentOneLiner(
      await rl.question('Project one-liner for the delegated agent session: ')
    );
    if (!answer) {
      process.stderr.write('Project one-liner is required for --mode=agent.\n');
      process.exitCode = 1;
      return null;
    }
    return answer;
  } finally {
    rl.close();
  }
}

async function runAgentDelegationMode(
  oneLinerValue: string | undefined,
  runtimeValue: string | undefined,
  interactive: boolean,
): Promise<void> {
  const oneLiner = await resolveOneLiner(oneLinerValue, interactive);
  if (!oneLiner) {
    return;
  }

  const runtime = parseAgentRuntime(runtimeValue);
  const template = await readText(
    path.join(paths.root, '.claude', 'templates', 'agent-delegation-prompt.md'),
  );
  const renderedBody = renderAgentDelegationPromptBody(template, oneLiner, runtime);

  await recordSharedConfigMode('agent');
  process.stdout.write(formatAgentDelegationPrompt(renderedBody, runtime));
}

// ─── project customization ────────────────────────────────────────

function formatReviewSignals(platform: string): string {
  const platforms = platform
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return [
    '<!-- BEGIN:PROJECT:review-signals -->',
    `platforms = ${JSON.stringify(platforms)}`,
    '<!-- END:PROJECT:review-signals -->',
  ].join('\n');
}

async function customizeProduct(rl: readline.Interface): Promise<void> {
  hr();
  console.log('\n📋 Step 1/3 — 프로젝트 기본 정보\n');

  const name = await ask(rl, '  프로젝트 이름이 뭔가요?\n  예) 우리동네 맛집 지도, 할일 관리 앱\n  > ');
  if (!name) { logger.info('프로젝트 이름이 비어 있어 product.md 설정을 건너뜁니다.'); return; }

  const description = await ask(rl, '\n  한 줄로 설명해주세요. 이 프로젝트는 뭘 하나요?\n  예) 내 주변 맛집을 지도에서 찾고 리뷰를 남길 수 있는 웹앱\n  > ');

  const goals = await askMultiLine(rl,
    '\n  이 프로젝트가 성공하려면 뭐가 되어야 하나요? (목표를 자유롭게 적어주세요)');

  const platform = await ask(rl,
    '\n  어디서 동작하나요? (여러 개면 쉼표로 구분)\n  예) 웹, 모바일앱, 데스크톱, 카카오톡 챗봇\n  > ');

  const content = `# Product context

이 저장소는 **${name}** — ${description || '(설명 미입력)'}

## 성공 기준
${goals.length > 0 ? goals.map(g => `- ${g}`).join('\n') : '- (아직 정의되지 않음)'}

## 플랫폼
${platform ? platform.split(',').map(p => `- ${p.trim()}`).join('\n') : '- (아직 정의되지 않음)'}

${formatReviewSignals(platform)}
`;

  await writeText(path.join(paths.root, 'docs', 'context', 'product.md'), content);
  logger.info('docs/context/product.md 작성 완료');
}

async function customizeArchitecture(rl: readline.Interface): Promise<void> {
  hr();
  console.log('\n🏗️  Step 2/3 — 기술 스택\n');
  console.log('  잘 모르는 항목은 비워두셔도 됩니다. AI가 나중에 채워넣을 수 있어요.\n');

  const stack = await ask(rl,
    '  어떤 기술로 만들 건가요? 알고 있는 것만 적어주세요.\n  예) React, Next.js, Python, Three.js\n  > ');

  const hosting = await ask(rl,
    '\n  어디에 배포/호스팅 할 예정인가요?\n  예) Vercel, AWS, Firebase, 아직 모름\n  > ');

  const database = await ask(rl,
    '\n  데이터 저장은 어떻게 하나요?\n  예) PostgreSQL, Firebase, Supabase, 로컬 파일, 아직 모름\n  > ');

  const content = `# Architecture context

## 기술 스택
- **프레임워크 / 라이브러리**: ${stack || '(미정)'}
- **호스팅 / 배포**: ${hosting || '(미정)'}
- **데이터 저장**: ${database || '(미정)'}

## 레이어

1. **Memory layer** — AI가 읽는 컨텍스트
   - \`CLAUDE.md\`, \`AGENTS.md\`, \`GEMINI.md\`
   - \`.claude/skills/*\`
   - \`docs/context/*\`

2. **Control plane** — 오케스트레이션 실행
   - \`src/commands/*\`
   - \`src/providers/*\`
   - \`.vibe/config*.json\`

3. **Execution / evidence layer** — 실행 기록
   - \`.vibe/runs/*\`
   - \`docs/plans/*\`
   - \`docs/reports/*\`

## 설계 원칙

- 얇은 루트 메모리 — 상세 규칙은 shard로 분리
- 설정 가능 provider runner — \`.vibe/config.local.json\`으로 provider 교체 가능
- Sprint 실패 시 Evaluator 판정 기반 Planner 재생성 에스컬레이션
- JSONL evidence 축적

## 프로젝트별 디렉터리 구조

\`\`\`text
(프로젝트 구조는 첫 구현 후 자동으로 업데이트됩니다)
\`\`\`
`;

  await writeText(path.join(paths.root, 'docs', 'context', 'architecture.md'), content);
  logger.info('docs/context/architecture.md 작성 완료');
}

async function customizeConventions(rl: readline.Interface): Promise<void> {
  hr();
  console.log('\n📐 Step 3/3 — 코드 스타일 및 선호도\n');
  console.log('  모르는 항목은 비워두시면 AI가 기술 스택에 맞게 자동 선택합니다.\n');

  const language = await ask(rl,
    '  주 프로그래밍 언어는 뭔가요?\n  예) TypeScript, Python, Java, Go, 잘 모름\n  > ');

  const style = await ask(rl,
    '\n  코드 스타일에 선호가 있나요?\n  예) 깔끔하고 읽기 쉬운 코드, 성능 우선, 간결함 우선, 특별히 없음\n  > ');

  const testing = await ask(rl,
    '\n  테스트 도구를 알고 계시면 적어주세요.\n  예) Jest, Vitest, pytest, 잘 모름\n  > ');

  const extra = await askMultiLine(rl,
    '\n  AI에게 추가로 지켜달라고 할 규칙이 있나요? (없으면 바로 엔터)');

  const content = `# Conventions

## 기본 규칙

- 변경은 최소 범위로 한다.
- 로그는 사람이 읽기 쉽게 남긴다.
- 스크립트는 실패 원인을 명확히 출력한다.
- 문서/보고서는 짧고 결정 사항 중심으로 유지한다.

## 프로젝트별 규칙

- **언어 / 런타임**: ${language || '(AI가 기술 스택에 맞게 선택)'}
- **코드 스타일**: ${style || '(기본: 깔끔하고 읽기 쉬운 코드)'}
- **테스트**: ${testing || '(AI가 기술 스택에 맞게 선택)'}
${extra.length > 0 ? '\n## 추가 규칙\n' + extra.map(e => `- ${e}`).join('\n') + '\n' : ''}`;

  await writeText(path.join(paths.root, 'docs', 'context', 'conventions.md'), content);
  logger.info('docs/context/conventions.md 작성 완료');
}

// ─── main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!guardAgentSkillInvocation()) {
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const mode = parseInitMode(getStringFlag(args, 'mode')) ?? (await promptInitMode(interactive));

  if (!mode) {
    return;
  }

  if (mode === 'agent') {
    await runAgentDelegationMode(
      getStringFlag(args, 'one-liner'),
      getStringFlag(args, 'runtime'),
      interactive,
    );
    return;
  }

  await recordSharedConfigMode('human');
  await ensureUpstreamConfig();
  await ensureEnvFile();
  await ensureInitialAgentState();

  const base = await readJson<VibeConfig>(paths.localConfigExample);

  // config.local.json 설정
  if (await fileExists(paths.localConfig)) {
    logger.info('.vibe/config.local.json already exists');
  } else if (!interactive) {
    await writeJson(paths.localConfig, base);
    logger.info('created .vibe/config.local.json with defaults');
  } else {
    const rl = readline.createInterface({ input, output });
    try {
      const planner = await promptValue(
        rl,
        'planner (WHAT 정의)',
        formatSprintRoleFallback(base.sprintRoles?.planner, 'claude-opus'),
      );
      const generator = await promptValue(
        rl,
        'generator (코드 구현)',
        formatSprintRoleFallback(base.sprintRoles?.generator, 'codex'),
      );
      const evaluator = await promptValue(
        rl,
        'evaluator (체크리스트 판정)',
        formatSprintRoleFallback(base.sprintRoles?.evaluator, 'claude-opus'),
      );

      const localConfig: VibeConfig = {
        ...base,
        sprintRoles: { planner, generator, evaluator },
      };

      await writeJson(paths.localConfig, localConfig);
      logger.info('created .vibe/config.local.json');
    } finally {
      rl.close();
    }
  }

  // 인터랙티브가 아니면 여기서 종료
  if (!interactive) return;

  // 프로젝트 커스터마이징
  const rl = readline.createInterface({ input, output });

  try {
    hr();
    console.log('\n🚀 프로젝트 맞춤 설정\n');
    console.log('  이 단계에서는 프로젝트에 대한 기본 정보를 입력받아');
    console.log('  AI가 작업할 때 참고할 문서를 자동으로 만들어줍니다.');
    console.log('  코딩 지식이 없어도 괜찮습니다!\n');

    const wantCustomize = await askYesNo(rl, '  프로젝트 맞춤 설정을 진행할까요?');

    if (!wantCustomize) {
      console.log('\n  맞춤 설정을 건너뜁니다. 나중에 docs/context/ 파일을 직접 편집하거나');
      console.log('  npm run vibe:init 을 다시 실행하면 됩니다.\n');
      return;
    }

    console.log('');
    await customizeProduct(rl);
    await customizeArchitecture(rl);
    await customizeConventions(rl);

    hr();
    console.log('\n✅ 프로젝트 맞춤 설정 완료!\n');
    console.log('  작성된 파일:');
    console.log('    - docs/context/product.md      (프로젝트 목표)');
    console.log('    - docs/context/architecture.md  (기술 스택)');
    console.log('    - docs/context/conventions.md   (코드 규칙)\n');
    console.log('  이제 AI에게 목표를 말하면 바로 작업을 시작할 수 있습니다.');
    console.log('  예) "Goal: 로그인 페이지를 만들어줘"\n');
  } finally {
    rl.close();
  }
}

runMain(main, import.meta.url);
