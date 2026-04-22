# Expert-level probes — INSPIRATION ONLY, do not copy verbatim

- 실제 비즈니스가 요구하는 것은 exactly-once인가, 아니면 idempotent at-least-once로 충분한가?
- 중복 허용이 안 되는 레코드와 약간의 중복이 허용되는 레코드를 동일 파이프라인에서 어떻게 구분하는가?
- watermark 전략은 source event time, ingest time, hybrid 중 무엇이며 late-arriving data 허용 창은 얼마인가?
- 데이터가 늦게 도착했을 때 결과를 수정할지, 보정 이벤트를 따로 발행할지, 재집계를 허용할지?
- backfill이 같은 테이블과 같은 sink를 건드릴 때 idempotency key는 무엇인가?
- schema evolution이 필연적일 때 nullable 추가, enum 확장, breaking rename 중 어떤 변경이 가장 자주 일어나는가?
- CDC 입력이라면 delete/tombstone 의미를 downstream에서 어떻게 유지하는가?
- 재처리(replay) 시 외부 부수효과가 있다면 exactly-once를 어디까지 보장할 수 있는가?
- 배치와 스트리밍 결과가 엇갈릴 때 어느 쪽을 진실의 원천으로 취급하는가?
- 파이프라인 장애의 실제 비용이 지연인지, 잘못된 집계인지, 규제 보고 실패인지 무엇인가?
- 파티셔닝 키가 skew를 일으킬 가능성이 높은지, hot key 완화가 필요한지?
- source ordering을 신뢰할 수 없는 경우 dedupe window를 어떤 근거로 정하는가?
- 데이터 품질 게이트는 null rate, referential integrity, freshness, uniqueness 중 무엇을 최소로 강제해야 하는가?
- sink가 데이터 웨어하우스인지 serving DB인지에 따라 upsert 전략은 어떻게 달라지는가?
- replay와 compaction 이후에도 audit trail이 남아야 하는지, 규제/금융 맥락인지?
- backfill 도중 실시간 consumer와 충돌하지 않게 namespace, topic, table을 어떻게 분리하는가?
- 운영자가 midnight incident 때 가장 먼저 확인해야 하는 지표는 lag인지 throughput인지 bad record rate인지?
