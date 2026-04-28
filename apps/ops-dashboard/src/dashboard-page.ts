import { DASHBOARD_CLIENT_SCRIPT } from "./dashboard-client.js";
import { DASHBOARD_STYLES } from "./dashboard-styles.js";

export function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Telegram Local Ingest 운영 대시보드</title>
  <style>
${DASHBOARD_STYLES}
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand">
        <div class="brand-mark">TL</div>
        <div class="brand-copy">
          <h1>Telegram Local Ingest 운영 콘솔</h1>
          <div class="brand-subtitle">파일 수집, 자동화, 위키 산출물, 실시간 로그를 한 화면에서 감시합니다.</div>
        </div>
      </div>
      <div class="toolbar">
        <span id="sseStatus" class="status warn connection">연결 전</span>
        <input id="token" type="password" placeholder="관리 토큰">
        <button id="refresh" class="ghost">새로고침</button>
        <button id="dispatch" class="primary">예약 실행 처리</button>
      </div>
    </div>
  </header>
  <main>
    <section id="summary" class="summary-grid" aria-label="운영 상태 요약"></section>

    <div class="ops-grid">
      <section class="surface">
        <div class="surface-head">
          <div class="surface-title">
            <span class="surface-kicker">Automation</span>
            <h2>자동화 모듈</h2>
            <span class="muted">스케줄, 준비도, 수동 실행 상태</span>
          </div>
        </div>
        <div class="surface-body" id="modules"></div>
      </section>

      <section class="surface">
        <div class="surface-head">
          <div class="surface-title">
            <span class="surface-kicker">Live</span>
            <h2>실시간 로그</h2>
            <span class="muted">앱 로그와 선택한 실행의 stdout/stderr</span>
          </div>
          <div class="toolbar">
            <span class="status ok">SSE</span>
          </div>
        </div>
        <div class="surface-body">
          <div class="toolbar">
            <select id="logTarget" aria-label="로그 대상">
              <option value="worker">Worker</option>
              <option value="bot-api">Telegram Bot API</option>
              <option value="ops-dashboard">Ops Dashboard</option>
            </select>
            <button id="logPause">일시정지</button>
            <button id="logClear">비우기</button>
          </div>
          <pre id="liveLog" class="live-log"></pre>
        </div>
      </section>
    </div>

    <div class="runs-grid">
      <section class="surface">
        <div class="surface-head">
          <div class="surface-title">
            <span class="surface-kicker">Runs</span>
            <h2>최근 자동화 실행</h2>
            <span class="muted">최근 20개 실행과 raw/wiki 링크</span>
          </div>
        </div>
        <div class="surface-body" id="runs"></div>
      </section>

      <section class="surface">
        <div class="surface-head">
          <div class="surface-title">
            <span class="surface-kicker">Artifacts</span>
            <h2>2차 산출물 / Generated Renderer</h2>
            <span class="muted">프롬프트 검토와 Registered 승격</span>
          </div>
        </div>
        <div class="surface-body" id="artifactRuns"></div>
      </section>
    </div>

    <section class="surface detail-surface">
      <div class="surface-head">
        <div class="surface-title">
          <span class="surface-kicker">Inspector</span>
          <h2>실행 상세</h2>
          <span class="muted">선택한 실행의 결과, 프롬프트, 코드, 로그</span>
        </div>
      </div>
      <div class="surface-body">
        <div id="detail" class="empty">실행 로그를 선택하세요.</div>
      </div>
    </section>
  </main>
  <script>
${DASHBOARD_CLIENT_SCRIPT}
  </script>
</body>
</html>`;
}
