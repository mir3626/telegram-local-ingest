# Expert-level probes — INSPIRATION ONLY, do not copy verbatim

- 이 시스템의 핵심 산출물이 논문, 재현 가능한 artifact, 데이터셋, 규제 보고서 중 무엇인가?
- reproducibility를 위해 고정해야 하는 것은 코드 버전, 데이터 snapshot, random seed, 환경 이미지 중 어디까지인가?
- data provenance를 파일 단위로 남길지, 샘플 단위로 남길지, 파생 테이블 단위로 남길지?
- 실험 결과를 나중에 검증할 때 citation chain이 필요한지, 어떤 외부 소스를 추적해야 하는가?
- IRB 또는 윤리 심의 범위가 사용자 데이터 수집, human subject experiment, 의료/생명과학 데이터까지 걸리는가?
- negative result도 저장해야 하는지, 그렇다면 어떤 메타데이터가 없으면 재해석이 불가능한가?
- artifact versioning은 논문 제출 시점과 실험 반복 시점을 어떻게 연결해야 하는가?
- compute environment가 GPU 드라이버, 라이브러리, 컨테이너 해시 수준까지 고정되어야 하는가?
- 데이터 정제 단계가 결과를 얼마나 바꾸는지 audit 가능하게 남겨야 하지 않는가?
- 공개 데이터와 비공개 민감 데이터가 섞일 때 reproduction package를 어떻게 분리할 것인가?
- 실험 파라미터 스윕 중 어떤 값이 탐색적 분석이고 어떤 값이 최종 보고용인지 경계를 남겨야 하는가?
- benchmark 결과를 비교할 때 동일 preprocessing과 동일 evaluation split을 강제할 수 있는가?
- 사람이 개입하는 labeling 또는 adjudication 단계가 있으면 inter-rater disagreement를 어떻게 기록할 것인가?
- 저자/연구자별 권한 차이가 원본 데이터 접근과 결과 승인 절차를 어떻게 나누는가?
- long-running experiment가 중단되었을 때 partial result를 어떻게 복구하고 표시하는가?
- 연구비/클러스터 예산 제한이 실험 설계나 샘플 수를 실제로 제한하는가?
- peer review 이후 correction이나 retraction이 필요할 때 어떤 증거를 남겨야 대응 가능한가?
