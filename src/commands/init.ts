import process from 'node:process';
import path from 'node:path';
import { copyFile } from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { runMain } from '../lib/cli.js';
import { fileExists, readJson, writeJson, writeText } from '../lib/fs.js';
import { logger } from '../lib/logger.js';
import { paths } from '../lib/paths.js';
import type { SprintRoleDefinition, VibeConfig } from '../lib/config.js';

// ─── helpers ───────────────────────────────────────────────────────

function hr(): void {
  console.log('─'.repeat(60));
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

// ─── project customization ────────────────────────────────────────

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
  await ensureEnvFile();

  const base = await readJson<VibeConfig>(paths.localConfigExample);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

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
