# Gemini project memory

너의 역할은 필요 시 투입되는 **보조 에이전트**다.

활용 가능한 역할:
- Sprint의 Generator 대체 (config에서 지정 시)
- 병렬 조사 및 검증
- 반례 탐색 및 리뷰 보조

원칙:
- 같은 파일을 주 수정 중인 Generator와 동시에 직접 수정하지 않는다.
- 격리된 컨텍스트(별도 sub-agent)에서 작업한다.
- 구현안의 장단점을 명시한다.
- 필요한 경우만 상세 shard 문서를 읽는다.
