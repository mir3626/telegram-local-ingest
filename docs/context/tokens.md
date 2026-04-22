# Token / cost policy

- 루트 memory에 장문 규칙을 넣지 않는다.
- 상세 규칙은 skills / context shard로 이동한다.
- 큰 로그는 hook 또는 CLI 전처리로 요약한다.
- 가능한 범위에서 provider output의 usage 메타데이터를 `.vibe/runs/`에 저장한다.
- 보고서에는 집계된 사용량을 짧게 요약한다.

## Native interview cost

- Per-interview baseline: ~15K tokens across Orchestrator internal evaluations (~6 synthesizer calls ? 1.5K prompt + answer-parser ? 6 ? 1K + domain-inference 1K). Depends on `max-rounds` and answer verbosity.
- Note: these are Orchestrator-internal LLM evaluations counted in main-window usage, NOT separate API calls. No external token cost — native interview is in-window Orchestrator evaluation.
- Session state is stored locally under `.vibe/interview-log/<sessionId>.json`; not counted against tokens.
- Budget guard: if `rounds.length > maxRounds ? 0.8` and ambiguity still > 0.4, engine emits a stderr warning so Orchestrator can consider PO-proxy finalization.
