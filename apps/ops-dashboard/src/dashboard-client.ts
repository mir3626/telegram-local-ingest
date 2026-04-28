export const DASHBOARD_CLIENT_SCRIPT = `    const tokenInput = document.getElementById('token');
    const logTarget = document.getElementById('logTarget');
    const liveLog = document.getElementById('liveLog');
    const sseStatus = document.getElementById('sseStatus');
    let eventSource = null;
    let livePaused = false;
    let currentState = null;
    const maxLiveLogChars = 160000;
    const recentTableLimit = 20;
    const headers = () => {
      const token = tokenInput.value.trim();
      return token ? {'content-type':'application/json','x-ops-dashboard-token': token} : {'content-type':'application/json'};
    };
    const api = async (url, options = {}) => {
      const res = await fetch(url, {...options, headers: {...headers(), ...(options.headers || {})}});
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    };
    const fmt = (value) => value ? new Date(value).toLocaleString() : '-';
    const fmtCompact = (value) => value ? new Date(value).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
    const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
    async function load() {
      const state = await api('/api/state');
      renderState(state);
    }
    function renderState(state) {
      currentState = state;
      renderSummary(state);
      renderModules(state.modules || []);
      renderRuns(state.runs || []);
      renderArtifactRuns(state.artifactRuns || []);
    }
    function renderSummary(state) {
      const modules = state.modules || [];
      const runs = state.runs || [];
      const artifacts = state.artifactRuns || [];
      const enabledModules = modules.filter((m) => m.enabled && m.available).length;
      const readinessIssues = modules.filter((m) => !m.available || !m.readiness?.ready).length;
      const failedRuns = runs.filter((run) => run.status === 'FAILED').length;
      const runningRuns = runs.filter((run) => run.status === 'RUNNING').length;
      const generatedArtifacts = artifacts.filter((run) => run.rendererMode === 'generated').length;
      const promotableArtifacts = artifacts.filter((run) => run.rendererMode === 'generated' && !run.promotedRendererId).length;
      const nextDueValues = modules.map((m) => m.nextDueAt).filter(Boolean).sort();
      const nextDue = nextDueValues[0] ? fmtCompact(nextDueValues[0]) : '-';
      const tone = (bad, warn) => bad ? 'bad' : warn ? 'warn' : 'ok';
      document.getElementById('summary').innerHTML = [
        metric('스택 연결', sseStatus.textContent || '확인 중', 'SSE 상태와 API 응답 기준', sseStatus.classList.contains('bad') ? 'bad' : sseStatus.classList.contains('ok') ? 'ok' : 'warn', 'NET'),
        metric('활성 모듈', enabledModules + '/' + modules.length, readinessIssues ? readinessIssues + '개 모듈 확인 필요' : '모든 모듈 준비됨', tone(readinessIssues > 0, enabledModules === 0 && modules.length > 0), 'MOD'),
        metric('실행 상태', runningRuns + ' running', failedRuns ? '최근 실패 ' + failedRuns + '건' : '최근 실패 없음', tone(failedRuns > 0, runningRuns > 0), 'RUN'),
        metric('다음 예약', nextDue, '스케줄러 기준 다음 due window', nextDueValues.length ? 'ok' : 'warn', 'DUE'),
        metric('산출물', String(generatedArtifacts), promotableArtifacts ? '승격 검토 ' + promotableArtifacts + '건' : '대기 없음', promotableArtifacts ? 'warn' : 'ok', 'ART'),
        metric('로그 대상', logTarget.value || 'worker', '선택 대상 실시간 tail', 'ok', 'LOG'),
      ].join('');
    }
    function metric(label, value, detail, tone, code) {
      return '<div class="metric" data-tone="' + esc(tone) + '" data-code="' + esc(code) + '">' +
        '<div class="metric-label-row"><div class="metric-icon">' + esc(code) + '</div><div class="metric-label">' + esc(label) + '</div></div>' +
        '<div class="metric-value">' + esc(value) + '</div>' +
        '<div class="metric-detail">' + esc(detail) + '</div>' +
      '</div>';
    }
    function statusClass(status) {
      return status === 'SUCCEEDED' || status === 'ready' || status === 'enabled' ? 'ok' : status === 'FAILED' || status === 'bad' ? 'bad' : 'warn';
    }
    function renderModules(modules) {
      if (modules.length === 0) {
        document.getElementById('modules').innerHTML = '<div class="empty">등록된 자동화 모듈이 없습니다.</div>';
        return;
      }
      document.getElementById('modules').innerHTML = '<div class="table-scroll modules-scroll"><table><thead><tr><th>모듈</th><th>상태</th><th>준비도</th><th>스케줄</th><th>최근 실행</th><th>작업</th></tr></thead><tbody>' +
        modules.map((m) => '<tr>' +
          '<td><strong>' + esc(m.title || m.id) + '</strong><br><span class="muted mono">' + esc(m.id) + '</span><br><span class="muted">' + esc(m.description || '') + '</span></td>' +
          '<td><span class="status ' + (m.available ? (m.enabled ? 'ok' : 'warn') : 'bad') + '">' + (m.available ? (m.enabled ? '켜짐' : '꺼짐') : '파일 없음') + '</span></td>' +
          '<td>' + (m.readiness?.ready ? '<span class="status ok">준비됨</span>' : '<span class="status bad">환경변수 누락</span><br><span class="muted">' + esc((m.readiness?.missingEnv || []).join(', ')) + '</span>') + '</td>' +
          '<td><strong>' + esc(m.schedule?.type || '-') + '</strong><br><span class="muted">다음 ' + esc(fmt(m.nextDueAt)) + '</span></td>' +
          '<td>' + (m.lastRun ? '<button class="id-button" data-run="' + esc(m.lastRun.id) + '">' + esc(m.lastRun.status) + '</button><br><span class="muted">' + esc(fmt(m.lastRun.startedAt)) + '</span>' : '<span class="muted">기록 없음</span>') + '</td>' +
          '<td><div class="actions">' +
            '<button data-enable="' + esc(m.id) + '">' + (m.enabled ? '끄기' : '켜기') + '</button>' +
            '<button class="primary" data-runmodule="' + esc(m.id) + '">실행</button>' +
          '</div></td>' +
        '</tr>').join('') + '</tbody></table></div>';
    }
    function renderRuns(runs) {
      const visible = runs.slice(0, recentTableLimit);
      if (visible.length === 0) {
        document.getElementById('runs').innerHTML = '<div class="empty">최근 실행 로그가 없습니다.</div>';
        return;
      }
      document.getElementById('runs').innerHTML = '<div class="table-scroll runs-scroll"><table><thead><tr><th>상태</th><th>실행 ID</th><th>모듈</th><th>시작</th><th>링크</th></tr></thead><tbody>' +
        visible.map((run) => '<tr>' +
          '<td><span class="status ' + statusClass(run.status) + '">' + esc(run.status) + '</span></td>' +
          '<td><button class="id-button mono" data-run="' + esc(run.id) + '">' + esc(run.id) + '</button></td>' +
          '<td><span class="mono">' + esc(run.moduleId) + '</span></td>' +
          '<td>' + esc(fmt(run.startedAt)) + '</td>' +
          '<td class="path-cell">' + renderRawLink(run.links?.rawBundlePath) + '</td>' +
        '</tr>').join('') + '</tbody></table></div>' +
        (runs.length > visible.length ? '<div class="table-note">최근 ' + visible.length + '개만 표시 중 / 전체 ' + runs.length + '개</div>' : '');
    }
    function renderRawLink(value) {
      if (!value) return '<span class="muted">-</span>';
      const short = String(value).split('/').filter(Boolean).slice(-1).join('/');
      return '<span class="status">raw</span> <span class="muted" title="' + esc(value) + '">' + esc(short) + '</span>';
    }
    function renderArtifactRuns(runs) {
      const visible = runs.slice(0, recentTableLimit);
      if (visible.length === 0) {
        document.getElementById('artifactRuns').innerHTML = '<div class="empty">생성된 2차 산출물 실행 로그가 없습니다.</div>';
        return;
      }
      document.getElementById('artifactRuns').innerHTML = '<div class="table-scroll artifact-scroll"><table><thead><tr><th>상태</th><th>실행 ID</th><th>종류</th><th>Renderer</th><th>사용자 프롬프트</th><th>Promote</th></tr></thead><tbody>' +
        visible.map((run) => '<tr>' +
          '<td><span class="status ' + statusClass(run.status) + '">' + esc(run.status) + '</span></td>' +
          '<td><button class="id-button mono" data-artifact-run="' + esc(run.id) + '">' + esc(run.id) + '</button><br><span class="muted">' + esc(fmt(run.createdAt)) + '</span></td>' +
          '<td>' + esc(run.artifactKind) + '<br><span class="muted">' + esc(run.artifactId) + '</span></td>' +
          '<td>' + esc(run.rendererMode) + '<br><span class="muted">' + esc(run.rendererId || run.rendererLanguage || '-') + '</span></td>' +
          '<td class="prompt-cell">' + esc((run.sourcePrompt || '').slice(0, 180)) + (run.sourcePrompt && run.sourcePrompt.length > 180 ? '...' : '') + '</td>' +
          '<td>' + (run.rendererMode === 'generated' ? (run.promotedRendererId ? '<span class="status ok">' + esc(run.promotedRendererId) + '</span>' : '<button class="primary" data-promote="' + esc(run.id) + '">Registered로 승격</button>') : '<span class="muted">등록됨</span>') + '</td>' +
        '</tr>').join('') + '</tbody></table></div>' +
        (runs.length > visible.length ? '<div class="table-note">최근 ' + visible.length + '개만 표시 중 / 전체 ' + runs.length + '개</div>' : '');
    }
    async function showRun(id) {
      const detail = await api('/api/runs/' + encodeURIComponent(id));
      ensureLogTarget('automation:' + id + ':stdout', '자동화 stdout: ' + id);
      ensureLogTarget('automation:' + id + ':stderr', '자동화 stderr: ' + id);
      selectLogTarget('automation:' + id + ':stdout');
      document.getElementById('detail').innerHTML = '<div><strong class="mono">' + esc(id) + '</strong></div>' +
        '<div class="detail-grid">' +
          detailKv('상태', detail.run.status || '-') +
          detailKv('Exit', detail.run.exitCode ?? '-') +
          detailKv('모듈', detail.run.moduleId || '-') +
          detailKv('시작', fmt(detail.run.startedAt)) +
          detailKv('Raw', detail.links?.rawBundlePath || '-') +
          detailKv('Wiki', detail.links?.wikiPagePath || '-') +
        '</div>' +
        logBlock('결과 result.json', detail.resultText || '', true) +
        '<div class="log-grid">' +
          logBlock('표준 출력 stdout.log', detail.stdout || '') +
          logBlock('오류 출력 stderr.log', detail.stderr || '') +
        '</div>';
    }
    async function showArtifactRun(id) {
      const detail = await api('/api/artifacts/runs/' + encodeURIComponent(id));
      ensureLogTarget('artifact:' + id + ':stdout', 'Artifact stdout: ' + id);
      ensureLogTarget('artifact:' + id + ':stderr', 'Artifact stderr: ' + id);
      selectLogTarget('artifact:' + id + ':stdout');
      const requestText = JSON.stringify(detail.run.request || {}, null, 2);
      document.getElementById('detail').innerHTML = '<div><strong class="mono">' + esc(id) + '</strong></div>' +
        '<div class="detail-grid">' +
          detailKv('상태', detail.run.status || '-') +
          detailKv('Renderer', detail.run.rendererMode || '-') +
          detailKv('종류', detail.run.artifactKind || '-') +
          detailKv('생성', fmt(detail.run.createdAt)) +
          detailKv('Derived', detail.run.derivedBundlePath || '-') +
          detailKv('Wiki', detail.run.wikiPagePath || '-') +
        '</div>' +
        logBlock('사용자 입력 프롬프트', detail.run.sourcePrompt || '', true) +
        logBlock('Artifact Request', requestText, true) +
        (detail.generatedCode ? logBlock('Generated Renderer 코드', detail.generatedCode, true) : '') +
        logBlock('결과 result.json', detail.resultText || '', true) +
        '<div class="log-grid">' +
          logBlock('표준 출력 stdout.log', detail.stdout || '') +
          logBlock('오류 출력 stderr.log', detail.stderr || '') +
        '</div>';
    }
    function detailKv(label, value) {
      return '<div class="kv"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>';
    }
    function logBlock(title, text, wide) {
      return '<div class="' + (wide ? 'wide-log' : '') + '"><h3>' + esc(title) + '</h3><pre>' + esc(text || '') + '</pre></div>';
    }
    function ensureLogTarget(value, label) {
      if ([...logTarget.options].some((option) => option.value === value)) return;
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      logTarget.append(option);
    }
    function selectLogTarget(value) {
      if (logTarget.value === value) return;
      logTarget.value = value;
      connectEvents();
    }
    function setConnection(status, label) {
      sseStatus.textContent = label;
      sseStatus.className = 'status connection ' + (status === 'ok' ? 'ok' : status === 'bad' ? 'bad' : 'warn');
      if (currentState) renderSummary(currentState);
    }
    function eventUrl() {
      const url = new URL('/events', window.location.href);
      url.searchParams.set('target', logTarget.value || 'worker');
      const token = tokenInput.value.trim();
      if (token) url.searchParams.set('token', token);
      return url.pathname + url.search;
    }
    function connectEvents() {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      if (!('EventSource' in window)) {
        setConnection('bad', 'SSE 불가');
        return;
      }
      setConnection('warn', '연결 중');
      eventSource = new EventSource(eventUrl());
      eventSource.onopen = () => setConnection('ok', '연결됨');
      eventSource.onerror = () => setConnection('bad', '재연결');
      eventSource.addEventListener('state', (event) => {
        const payload = JSON.parse(event.data);
        renderState(payload.state || {});
      });
      eventSource.addEventListener('log', (event) => {
        const payload = JSON.parse(event.data);
        if (payload.target !== logTarget.value || livePaused) return;
        if (payload.reset) appendLog('\\n[log rotated; cursor reset]\\n');
        if (payload.truncated) appendLog('\\n[older log content truncated]\\n');
        if (payload.missing) appendLog('\\n[log file not available yet]\\n');
        if (payload.chunk) appendLog(payload.chunk);
      });
      eventSource.addEventListener('log-error', (event) => {
        const payload = JSON.parse(event.data);
        if (payload.target === logTarget.value) appendLog('\\n[log error] ' + (payload.message || 'unknown') + '\\n');
      });
    }
    function appendLog(text) {
      liveLog.textContent += text;
      if (liveLog.textContent.length > maxLiveLogChars) {
        liveLog.textContent = liveLog.textContent.slice(-maxLiveLogChars);
      }
      liveLog.scrollTop = liveLog.scrollHeight;
    }
    document.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.dataset.run) await showRun(target.dataset.run);
      if (target.dataset.artifactRun) await showArtifactRun(target.dataset.artifactRun);
      if (target.dataset.promote) {
        const rendererId = prompt('등록할 renderer id를 입력하세요. 비워두면 자동 생성됩니다.', '');
        await api('/api/artifacts/runs/' + encodeURIComponent(target.dataset.promote) + '/promote', {method:'POST', body:JSON.stringify(rendererId ? {rendererId} : {})});
        await load();
        await showArtifactRun(target.dataset.promote);
      }
      if (target.dataset.enable) {
        const state = target.textContent === '켜기' ? 'enable' : 'disable';
        await api('/api/modules/' + encodeURIComponent(target.dataset.enable) + '/' + state, {method:'POST', body:'{}'});
        await load();
      }
      if (target.dataset.runmodule) {
        const detail = await api('/api/modules/' + encodeURIComponent(target.dataset.runmodule) + '/run', {method:'POST', body:JSON.stringify({force:true})});
        await load();
        await showRun(detail.run.id);
      }
    });
    document.getElementById('refresh').addEventListener('click', () => { load().catch(alert); connectEvents(); });
    document.getElementById('dispatch').addEventListener('click', async () => { await api('/api/dispatch', {method:'POST', body:JSON.stringify({dryRun:false})}); await load(); });
    logTarget.addEventListener('change', () => { liveLog.textContent = ''; if (currentState) renderSummary(currentState); connectEvents(); });
    document.getElementById('logPause').addEventListener('click', () => {
      livePaused = !livePaused;
      document.getElementById('logPause').textContent = livePaused ? '재개' : '일시정지';
    });
    document.getElementById('logClear').addEventListener('click', () => { liveLog.textContent = ''; });
    tokenInput.addEventListener('change', connectEvents);
    load().then(connectEvents).catch((error) => { document.getElementById('modules').textContent = error.message; });
`;
