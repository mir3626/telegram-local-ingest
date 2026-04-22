# Codex project memory

<!-- BEGIN:HARNESS:agent-memory -->
너의 기본 역할은 Sprint의 **Generator (코드 구현)** 다.

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

## 인코딩 무결성 (필수 — Korean Windows)
- 비-ASCII string literal(한국어 등)을 절대 round-trip으로 손상시키지 않는다. 작업 종료 전 다음을 검증:
  - `file <touched files>` → `UTF-8 Unicode text`
  - `LC_ALL=C grep -lE '"\?[^"]*"' <touched files>` → 빈 결과 (mojibake 0건)
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
