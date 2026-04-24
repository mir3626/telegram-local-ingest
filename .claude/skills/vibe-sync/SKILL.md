---
name: vibe-sync
description: 다운스트림 프로젝트가 업스트림 vibe-doctor 템플릿의 하네스(스크립트·스킬·에이전트 설정)를 프로젝트 커스터마이징을 보존하면서 안전하게 싱크합니다.
---

이 스킬은 `.vibe/sync-manifest.json`의 소유권 분류(harness / hybrid / project)에 따라
업스트림 변경만 반영하고 프로젝트 고유 섹션은 건드리지 않습니다.

## 언제 소환하나

- `SessionStart` 훅(`vibe-version-check.mjs`)이 "하네스 업데이트 가능" 메시지를 출력했을 때
- 사용자가 `/vibe-sync` 또는 `npm run vibe:sync`를 직접 요청했을 때
- `vibe-preflight.mjs`가 `harness.version` 불일치를 경고로 보고했을 때

## 실행 흐름

1. `npx tsx src/commands/sync.ts --dry-run` 먼저 실행 — plan 테이블 확인
2. plan에 `conflict` 항목이 있으면 사용자에게 항목별로 제시:
   - `conflict`: 로컬이 이전 싱크 이후 수정됨 → 덮어쓸지(`--force` 또는 프롬프트 `y`) 유지할지(`n`) 선택
   - `new-file`, `replace`, `section-merge`, `json-merge`는 기본 진행
3. 사용자 승인 후 `npx tsx src/commands/sync.ts` 본 실행
4. 자동 검증: harness-only typecheck(`tsconfig.harness.json`이 있으면 `npx tsc -p tsconfig.harness.json --noEmit`) + `node scripts/vibe-preflight.mjs --bootstrap`
5. 실패 시 `.vibe/sync-backup/<timestamp>/`에서 롤백 경로 안내

## 옵션

| 플래그 | 용도 |
|---|---|
| `--dry-run` | plan만 출력, 실제 적용 없음 |
| `--force` | conflict를 모두 upstream으로 덮어씀 (비대화형) |
| `--from <path>` | 로컬 디렉터리를 업스트림 소스로 (git clone 대신) |
| `--ref <tag>` | 업스트림 git 참조 override |
| `--no-backup` | 백업 생략 (비권장) |
| `--no-verify` | 싱크 후 harness typecheck/preflight 생략 |
| `--json` | plan을 JSON으로 출력 |

## 레거시 프로젝트 부트스트랩

마커(`<!-- BEGIN:HARNESS:* -->`)가 없는 구형 프로젝트는 정규 `/vibe-sync`로 업그레이드할
수 없습니다. 한 번만 `scripts/vibe-sync-bootstrap.mjs`를 실행해 마커/매니페스트/버전
필드를 부트스트랩한 뒤 `/vibe-sync`를 정상 사용합니다.

실행 방법은 환경별로 다릅니다. 레거시 프로젝트 루트에서 아래 중 하나를 실행합니다:

**공통 (모든 환경 — 로컬 clone 방식, 가장 안전)**
```bash
git clone --depth 1 https://github.com/mir3626/vibe-doctor /tmp/vibe-doctor
node /tmp/vibe-doctor/scripts/vibe-sync-bootstrap.mjs
```

**macOS / Linux (프로세스 치환 사용)**
```bash
node <(curl -sL https://raw.githubusercontent.com/mir3626/vibe-doctor/main/scripts/vibe-sync-bootstrap.mjs)
```

**Windows (Git Bash / PowerShell / cmd — stdin 파이프)**
```bash
curl -sL https://raw.githubusercontent.com/mir3626/vibe-doctor/main/scripts/vibe-sync-bootstrap.mjs | node --input-type=module -
```

> Windows 주의: `<(...)` 프로세스 치환은 Git Bash가 `/dev/fd/N` 가상 경로를 반환하는데
> 네이티브 `node.exe`가 이를 이해하지 못해 "지정된 파일을 찾을 수 없습니다"로 실패합니다.
> 반드시 stdin 파이프(`| node --input-type=module -`)나 로컬 clone 방식을 사용하세요.
> `--input-type=module`은 ESM 구문을 위해 필수입니다.

## 주의

- `.vibe/config.json`의 `upstream` 필드가 없으면 v1.5.14+ sync/version-check가 기본 vibe-doctor upstream을 추론합니다. 영구 floating 업데이트를 원하면 `"ref": "^vX.Y.Z"`를 추가하고, exact `"ref": "vX.Y.Z"`는 의도적인 pin일 때만 사용합니다.
- post-sync typecheck는 하네스 소유 파일만 검증합니다. product `tsconfig.json`은 project-owned 이므로 `/vibe-sync` 성공/실패 판정에 끌어오지 않습니다.
- `PROJECT:*` 마커 섹션과 `<!-- BEGIN:PROJECT:custom-rules -->` 블록은 **절대** 수정되지 않습니다.
- 싱크 후 `.vibe/config.json`의 `harnessVersionInstalled`가 `harnessVersion`과 일치해야 합니다.

## 업스트림 태그 컨벤션 (릴리스 contract)

업스트림은 릴리스마다 `v{major}.{minor}.{patch}` 형식으로 태그를 찍습니다(예: `v1.0.0`,
`v1.0.1`). 다운스트림은 아래 우선순위로 참조를 결정합니다:

1. `--ref <x>` CLI 플래그 (최고 우선, 이번 실행에서만 override)
2. `.vibe/config.json`의 `upstream.ref` 필드
   - exact `vX.Y.Z` 또는 `X.Y.Z`: hard pin. plain sync는 해당 태그에 머뭅니다.
   - caret `^vX.Y.Z` 또는 `^X.Y.Z`: floating compatible range. plain sync는 캐시된 최신 호환 태그로 이동합니다.
   - `main` 같은 브랜치 이름: 그대로 사용합니다.
3. `upstream.ref`가 없으면 캐시된 `latestVersion`이 설치 버전보다 최신일 때 그 태그 사용
4. 캐시 업데이트가 없으면 `harnessVersion`의 `v{harnessVersion}` 태그 시도
5. 그래도 안 되면 `main`으로 fallback

기본 템플릿은 caret ref를 사용합니다. 따라서 일반 사용자는 `/vibe-sync`만 실행해도 호환되는
최신 하네스로 이동합니다. exact ref는 의도적인 pin이 필요할 때만 사용합니다. 기존 프로젝트가
`"ref": "v1.5.15"`처럼 exact ref에 머물러 있다면, 계속 pin하려는 의도가 아니면
`"ref": "^v1.5.15"`로 바꾸거나 `npm run vibe:sync -- --ref vX.Y.Z`로 한 번 업데이트합니다.

### 기존 legacy 프로젝트가 이미 ref 없이 부트스트랩된 경우

- 일회성 우회: `npm run vibe:sync -- --ref main` 또는 `npm run vibe:sync -- --ref vX.Y.Z`
- 영구 floating 설정: `.vibe/config.json`의 `upstream` 블록에 `"ref": "^vX.Y.Z"`를 추가
