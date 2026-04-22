# Secrets policy

## 기본 규칙
- `.env`, `.env.*`, `secrets/**`, `config/credentials.json`은 repo에 저장하지 않는다.
- 단순 base64 인코딩은 보안 대책이 아니다.
- 자격증명은 OS 키체인, provider CLI 로그인 캐시, gitignored local config를 우선 사용한다.
- 민감 파일 접근은 필요 시 최소 범위만 허용한다.

## 환경변수 관리

`npm run vibe:init` 실행 시 `.env.example`을 복사해 `.env`를 자동 생성한다.

| 파일 | git 커밋 | 용도 |
|------|----------|------|
| `.env.example` | O (커밋) | 변수 목록 및 설명 템플릿 |
| `.env` | X (gitignore) | 실제 키/토큰 값 |

## Provider 인증 우선순위

| Provider | 권장 방식 | 대체 방식 |
|----------|-----------|-----------|
| claude | `claude` CLI 로그인 | `ANTHROPIC_API_KEY` |
| codex | `codex login --device-auth` | `OPENAI_API_KEY` |
| gemini | `gemini` OAuth 브라우저 로그인 | `GEMINI_API_KEY` |

CLI 로그인 캐시(`~/.codex/auth.json`, `~/.gemini/`)는 프로젝트 외부에 저장되므로 git에 노출되지 않는다.

## Sprint-mode 보안 가이드

`/vibe-sprint-mode on`은 `.claude/settings.local.json`에 scope 기반 permission 규칙을 추가한다.

### 범위 제한
- 허용 대상: `npm install/ci/run`, `npx tsc/vitest/eslint/playwright`, `node scripts/`, `git` 기본 명령.
- 허용되지 않는 것: 임의 shell 명령, `rm`, `curl`, 파일 시스템 직접 조작, 네트워크 요청 도구.

### 주의 사항
- **npm postinstall 공격**: `npm install`이 허용되므로 악성 패키지의 postinstall 스크립트가 실행될 수 있다. 신뢰하지 않는 의존성 추가 시 `--ignore-scripts` 사용.
- **git push**: preset에 `git push`가 포함됨. 자동 push를 원하지 않으면 해당 규칙만 수동 제거.
- **해제**: `/vibe-sprint-mode off`로 preset 규칙만 정확히 제거. 사용자 커스텀 규칙은 보존.
