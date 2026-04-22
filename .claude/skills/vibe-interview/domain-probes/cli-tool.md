# Expert-level probes — INSPIRATION ONLY, do not copy verbatim

- 사용자가 주로 직접 타이핑하는 CLI인지, 스크립트/CI에서 호출하는 CLI인지에 따라 인터페이스를 어떻게 달리할 것인가?
- stdin과 argv 중 어떤 입력 채널이 기본이어야 quoting 문제와 대용량 payload를 모두 감당할 수 있는가?
- POSIX shell과 Windows PowerShell/cmd quoting 차이가 실제 사용성을 깨뜨리는 지점은 어디인가?
- exit code contract가 단순 성공/실패인지, 경고/부분성공/사용자오류/환경오류를 나눠야 하는가?
- config precedence order를 env > flag > file로 둘지, flag > env > file로 둘지, 왜 그런가?
- `.toolrc`, project-local config, global config가 동시에 있을 때 충돌 해소 규칙은 무엇인가?
- 파이프라인에서 쓰이는 명령이라면 human-readable output과 machine-readable output을 어떻게 분리할 것인가?
- `--help`와 man-page가 서로 다른 정보를 담으면 사용자가 가장 먼저 실패하는 시나리오는 무엇인가?
- destructive command가 있다면 dry-run, confirm, force 중 어떤 안전장치가 필수인가?
- glob expansion을 shell에 맡길지, CLI 내부에서 cross-platform으로 처리할지?
- 표준 출력은 순수 데이터만 내보내고 진단은 stderr로 분리해야 downstream 스크립트가 안전한가?
- tty 여부에 따라 progress, color, prompt 행동이 어떻게 달라져야 하는가?
- 하위 명령 간에 공통 플래그 이름이 달라지면 학습 비용이 얼마나 커지는가?
- 네트워크 실패와 사용자 입력 오류를 같은 exit code로 처리하면 자동화가 무엇을 놓치는가?
- Windows 경로 구분자, UNC path, drive letter가 POSIX path 가정과 충돌하는 지점은 어디인가?
- config file format이 JSON, YAML, TOML 중 무엇일 때 사람이 고치기 쉽고 기계 검증이 쉬운가?
- backward-compatible flag deprecation을 어떤 기간과 경고 방식으로 운영해야 CI break를 막을 수 있는가?
