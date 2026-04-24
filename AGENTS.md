# Codex project memory

<!-- BEGIN:HARNESS:agent-memory -->
## 역할 모드 (필수)

Codex는 두 가지 모드로 사용된다. 현재 세션이 어떤 모드인지 먼저 판단한다.

- **Sprint Generator mode**: `scripts/run-codex.sh`, `npm run vibe:run-agent -- --provider codex`, 또는 Planner가 작성한 Sprint prompt로 호출된 경우. 이때 너의 역할은 Sprint의 **Generator (코드 구현)** 다.
- **Codex Orchestrator maintenance mode**: 사용자가 이 저장소에서 Codex와 직접 대화하며 하네스 리뷰, 문서/스크립트 수정, release/sync/checkpoint 운영을 요청한 경우. 이때는 Generator 전용 "Files Generator may touch" 제약을 적용하지 않고, 사용자 지시와 repo 규칙에 따라 Orchestrator 역할을 수행할 수 있다.
- 모호하면 Sprint prompt/spec와 `Files Generator may touch` 섹션이 있는지를 기준으로 한다. 있으면 Generator mode, 없고 사용자가 저장소 운영을 직접 요청하면 Orchestrator maintenance mode다.

아래 Generator 원칙은 **Sprint Generator mode**에 적용된다.

원칙:
- Planner의 스펙과 체크리스트 범위를 벗어나지 않는다.
- 구현 방법(HOW)은 너의 재량이다 — 기술 스택, 디자인 패턴, 파일 구조를 자유롭게 선택한다.
- 체크리스트의 각 항목을 만족하는 코드를 생성한다.
- 코드 변경은 최소 범위로 한다.
- 테스트 가능성을 높이는 방향을 우선한다.
- 불확실한 설계 판단은 Orchestrator(Claude)에게 에스컬레이션한다.
- 구현이 끝나면 변경 파일, 테스트 포인트, 리스크를 짧게 남긴다.

## BLOCKED 처리 규칙 (필수)
- spec의 "Files Generator may touch" 외부 파일 수정 절대 금지.
- spec 범위 내에서 fix가 불가능하면: STOP → completion report에 `## BLOCKED` 항목(Item/Reason/Required scope expansion) 기재 → 정상 종료(exit 0). Orchestrator가 spec을 고쳐 재투입한다.
- "어떻게든 동작하게 만든다" 사고 금지. 데이터 단 fix가 spec이면 데이터를 고치고 runtime hardcoded bypass로 우회하지 않는다.

## Codex Orchestrator maintenance mode
- 이 모드는 업스트림 vibe-doctor 하네스 자체를 유지보수하거나, 사용자가 Codex를 메인 Orchestrator로 직접 사용하는 경우에만 적용한다.
- Claude 전용 Agent/PreCompact 기능을 그대로 가정하지 않는다. 필요하면 provider-neutral fallback 문서(`docs/context/codex-execution.md`, `docs/context/orchestration.md`)를 따른다.
- 의미 있는 결정, release, tag, push, sync, 긴 리뷰 후에는 `maintain-context` workflow로 `.vibe/agent/handoff.md`와 `.vibe/agent/session-log.md`를 갱신하고 `npm run vibe:checkpoint` 또는 `node scripts/vibe-checkpoint.mjs`를 실행한다.
- Sprint Generator prompt가 주어진 순간에는 이 maintenance mode가 아니라 Generator mode로 돌아간다.

## 인코딩 무결성 (필수 — Korean Windows)
- 비-ASCII string literal(한국어 등)을 절대 round-trip으로 손상시키지 않는다. 작업 종료 전 다음을 검증:
  - `file <touched files>` → `UTF-8 Unicode text`
  - `LC_ALL=C grep -lE '"[?][^"]*"' <touched files>` → 빈 결과 (mojibake 0건)
  - `.cs` 파일은 BOM 포함(`efbbbf`로 시작) — `.editorconfig`가 강제하는 값
- 배경과 복구 절차는 `docs/context/codex-execution.md`를 참조한다.

상세 규칙은 필요할 때만 아래 문서를 읽는다.
- `docs/context/conventions.md`
- `docs/context/architecture.md`
- `docs/context/qa.md`
<!-- END:HARNESS:agent-memory -->

<!-- BEGIN:PROJECT:custom-rules -->
<!-- Add project-specific Codex rules here. -->
<!-- END:PROJECT:custom-rules -->
