# Expert-level probes — INSPIRATION ONLY, do not copy verbatim

- 멀티테넌트 경계가 org, workspace, project 중 어디에 걸리고, 이 선택이 권한 모델을 어떻게 바꾸는가?
- 청구 단위가 사용자 수, 활성 seat, 사용량, 조직별 flat fee 중 무엇이며 예외는 누가 승인하는가?
- 개인 사용자와 조직 관리자의 needs가 충돌할 때 제품은 누구를 우선하는가?
- SSO를 도입할 경우 IdP scope가 로그인만인지, 프로비저닝인지, 그룹 동기화까지 포함하는지?
- audit log retention이 규제 요건인지 단순 엔터프라이즈 기대치인지에 따라 저장 전략이 어떻게 달라지는가?
- rate limit 차원을 사용자, API key, org, IP 중 어디에 두어야 abuse와 정상 사용을 함께 처리할 수 있는가?
- sandbox workspace와 production workspace를 같은 tenant 안에 둘지 분리할지?
- tenant isolation이 논리적 분리로 충분한가, 특정 고객은 물리 분리를 요구하는가?
- 가격 책정 경계가 org billing admin과 product admin 역할을 갈라놓는가?
- B2B SaaS에서 진짜 온보딩 bottleneck은 기술 설정인지, 내부 승인 절차인지, 데이터 이전인지?
- usage overage가 발생했을 때 hard stop, soft warning, sales handoff 중 무엇이 churn을 줄이는가?
- enterprise 고객이 기대하는 export, DPA, residency, SCIM 범위는 어디까지인가?
- impersonation 기능이 지원/CS 효율을 높이는 대신 감사와 프라이버시 리스크를 얼마나 키우는가?
- 고객 성공팀이 제품 내부에서 직접 수정 가능한 설정과 개발팀만 건드려야 하는 설정의 경계는 어디인가?
- 조직 삭제와 사용자 탈퇴 중 어느 흐름이 더 위험하고 어떤 data retention 예외가 필요한가?
- shared resource를 tenant별 quota로 나눌 때 noisy neighbor를 어떤 지표로 감지하는가?
- "활성 사용자" 정의가 billing, adoption KPI, security review에서 각각 동일한가?
