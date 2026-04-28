export const DASHBOARD_STYLES = `    :root {
      color-scheme: light;
      font-family: "Inter", "Pretendard", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
      background: #f1f4f8;
      color: #0f172a;
      --ink: #0f172a;
      --ink-soft: #1e293b;
      --ink-mute: #475569;
      --muted: #64748b;
      --muted-soft: #94a3b8;
      --panel: #ffffff;
      --panel-solid: #ffffff;
      --panel-tint: #f8fafc;
      --line: #e2e8f0;
      --line-soft: #eef2f7;
      --line-strong: #cbd5e1;
      --wash: #f8fafc;
      --head: #f8fafc;
      --accent: #2563eb;
      --accent-strong: #1d4ed8;
      --accent-soft: #eff4ff;
      --accent-ink: #1e40af;
      --ok-bg: #e7f7ee;
      --ok-fg: #0f7a3f;
      --ok-ring: #c5edd2;
      --warn-bg: #fef4e0;
      --warn-fg: #92580b;
      --warn-ring: #f6dba1;
      --bad-bg: #fde8e8;
      --bad-fg: #b42121;
      --bad-ring: #f4c0c0;
      --neutral-bg: #eef2f7;
      --neutral-fg: #475569;
      --terminal-bg: #0b1220;
      --terminal-bg-2: #0f172a;
      --terminal-fg: #d6e2f3;
      --terminal-line: #1c2a44;
      --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 1px rgba(15, 23, 42, 0.03);
      --shadow: 0 1px 3px rgba(15, 23, 42, 0.06), 0 6px 20px rgba(15, 23, 42, 0.04);
      --shadow-lg: 0 12px 32px rgba(15, 23, 42, 0.08), 0 2px 6px rgba(15, 23, 42, 0.04);
      --radius-sm: 8px;
      --radius: 12px;
      --radius-lg: 16px;
      --metric-1: #2563eb;
      --metric-1-soft: #e3edff;
      --metric-2: #0d9488;
      --metric-2-soft: #d6f1ec;
      --metric-3: #d97706;
      --metric-3-soft: #fdebcd;
      --metric-4: #7c3aed;
      --metric-4-soft: #ede4fd;
      --metric-5: #db2777;
      --metric-5-soft: #fbe1ee;
      --metric-6: #0891b2;
      --metric-6-soft: #d6f0f7;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; }
    body {
      background: linear-gradient(180deg, #f5f7fa 0%, #eef2f6 58%, #e9edf3 100%);
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }

    .topbar { position: sticky; top: 0; z-index: 20; background: rgba(255, 255, 255, 0.82); border-bottom: 1px solid var(--line); backdrop-filter: saturate(160%) blur(14px); -webkit-backdrop-filter: saturate(160%) blur(14px); }
    .topbar-inner { max-width: 1500px; margin: 0 auto; padding: 14px 22px; display: flex; gap: 18px; align-items: center; justify-content: space-between; }
    .brand { min-width: 0; display: flex; align-items: center; gap: 14px; }
    .brand-mark {
      width: 40px; height: 40px;
      border-radius: 11px;
      display: grid; place-items: center;
      color: #ffffff;
      background: linear-gradient(135deg, #1e3a8a 0%, #1d4ed8 50%, #2563eb 100%);
      box-shadow: 0 8px 18px rgba(29, 78, 216, 0.28), inset 0 0 0 1px rgba(255, 255, 255, 0.18);
      font-weight: 800;
      letter-spacing: 0;
      font-size: 13px;
    }
    .brand-copy { min-width: 0; }
    h1 { font-size: 16px; margin: 0; color: var(--ink); letter-spacing: 0; font-weight: 700; }
    .brand-subtitle { margin-top: 3px; color: var(--muted); font-size: 12px; line-height: 1.35; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .topbar .toolbar { justify-content: flex-end; }

    main { max-width: 1500px; margin: 0 auto; padding: 20px 22px 36px; }
    section { min-width: 0; }
    h2 { font-size: 15px; line-height: 1.25; margin: 0; color: var(--ink); letter-spacing: 0; font-weight: 700; }
    h3 { font-size: 12.5px; margin: 14px 0 7px; color: var(--ink-soft); letter-spacing: 0; font-weight: 700; text-transform: uppercase; }

    button {
      border: 1px solid var(--line-strong);
      background: #ffffff;
      color: var(--ink);
      border-radius: var(--radius-sm);
      padding: 7px 12px;
      cursor: default;
      font: inherit;
      font-size: 12.5px;
      font-weight: 600;
      white-space: nowrap;
      box-shadow: var(--shadow-sm);
      transition: background .15s ease, border-color .15s ease, color .15s ease, transform .15s ease, box-shadow .15s ease;
    }
    button[data-run], button[data-enable], button[data-runmodule], button[data-artifact-run], button[data-promote], #refresh, #dispatch, #logPause, #logClear { cursor: pointer; }
    button[data-run]:hover, button[data-enable]:hover, button[data-runmodule]:hover, button[data-artifact-run]:hover, button[data-promote]:hover, #refresh:hover, #dispatch:hover, #logPause:hover, #logClear:hover {
      transform: translateY(-1px);
      border-color: var(--accent);
      color: var(--accent-ink);
      box-shadow: 0 4px 14px rgba(37, 99, 235, 0.12);
    }
    button.primary {
      background: linear-gradient(180deg, #2563eb 0%, #1d4ed8 100%);
      color: #ffffff;
      border-color: #1d4ed8;
      box-shadow: 0 6px 16px rgba(37, 99, 235, 0.22);
    }
    button.primary:hover { background: linear-gradient(180deg, #1d4ed8 0%, #1e40af 100%); border-color: #1e40af; color: #ffffff; box-shadow: 0 8px 22px rgba(37, 99, 235, 0.28); }
    button.ghost { background: #ffffff; color: var(--ink-soft); border-color: var(--line-strong); }
    button.ghost:hover { background: var(--accent-soft); }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    button:focus-visible, input:focus-visible, select:focus-visible {
      outline: 3px solid rgba(37, 99, 235, 0.22);
      outline-offset: 2px;
    }

    input, select {
      padding: 7px 11px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--line-strong);
      font: inherit;
      font-size: 12.5px;
      min-width: 200px;
      background: #ffffff;
      color: var(--ink);
      box-shadow: inset 0 1px 0 rgba(15, 23, 42, 0.02);
      transition: border-color .15s ease, box-shadow .15s ease;
    }
    input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14); }

    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: var(--terminal-bg);
      color: var(--terminal-fg);
      padding: 12px 14px;
      overflow: auto;
      max-height: 320px;
      border-radius: var(--radius-sm);
      font-size: 11.5px;
      line-height: 1.55;
      border: 1px solid var(--terminal-line);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
      font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    table { width: 100%; border-collapse: collapse; background: var(--panel-solid); }
    th, td { text-align: left; vertical-align: middle; padding: 11px 14px; border-bottom: 1px solid var(--line-soft); font-size: 12.5px; }
    th {
      background: var(--head);
      font-weight: 700;
      color: var(--muted);
      position: sticky;
      top: 0;
      z-index: 1;
      font-size: 10.5px;
      letter-spacing: 0;
      text-transform: uppercase;
      border-bottom: 1px solid var(--line);
    }
    tbody tr { transition: background .15s ease; }
    tbody tr:hover td { background: var(--accent-soft); }

    .muted { color: var(--muted); }
    .mono { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }

    .status {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-width: 64px;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0;
      background: var(--neutral-bg);
      color: var(--neutral-fg);
      border: 1px solid transparent;
      white-space: nowrap;
    }
    .status::before {
      content: "";
      width: 6px; height: 6px;
      border-radius: 50%;
      background: currentColor;
      opacity: 0.85;
      flex: 0 0 auto;
    }
    .ok { background: var(--ok-bg); color: var(--ok-fg); border-color: var(--ok-ring); }
    .bad { background: var(--bad-bg); color: var(--bad-fg); border-color: var(--bad-ring); }
    .warn { background: var(--warn-bg); color: var(--warn-fg); border-color: var(--warn-ring); }
    .connection { min-width: 84px; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }

    .surface {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      min-width: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .surface-head {
      min-height: 60px;
      padding: 14px 18px 12px;
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      border-bottom: 1px solid var(--line-soft);
      background: linear-gradient(180deg, #ffffff 0%, #fbfcfe 100%);
    }
    .surface-title { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .surface-kicker {
      font-size: 10px;
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0;
      font-weight: 700;
    }
    .surface-title .muted { font-size: 12px; line-height: 1.4; }
    .surface-body { padding: 14px 16px 16px; min-width: 0; flex: 1; }

    .table-scroll {
      overflow: auto;
      border: 1px solid var(--line-soft);
      border-radius: var(--radius-sm);
      background: var(--panel-solid);
    }
    .runs-scroll { max-height: 460px; }
    .modules-scroll { max-height: 520px; }
    .artifact-scroll { max-height: 460px; }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .metric {
      position: relative;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 14px 16px;
      min-height: 102px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      box-shadow: var(--shadow-sm);
      overflow: hidden;
      transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease;
    }
    .metric:hover { transform: translateY(-1px); box-shadow: var(--shadow); border-color: var(--line-strong); }
    .metric-label-row { display: flex; align-items: center; gap: 10px; }
    .metric-icon {
      flex: 0 0 auto;
      width: 30px; height: 30px;
      border-radius: 9px;
      display: grid; place-items: center;
      font-size: 9.5px;
      font-weight: 800;
      letter-spacing: 0;
      color: var(--metric-color, var(--metric-1));
      background: var(--metric-bg, var(--metric-1-soft));
      border: 1px solid color-mix(in srgb, var(--metric-color, var(--metric-1)) 18%, transparent);
    }
    .metric-label { color: var(--muted); font-size: 11.5px; font-weight: 600; letter-spacing: 0; }
    .metric-value {
      font-size: 24px;
      font-weight: 700;
      line-height: 1.1;
      letter-spacing: 0;
      color: var(--ink);
      overflow-wrap: anywhere;
    }
    .metric-detail {
      color: var(--muted);
      font-size: 11.5px;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    .metric[data-tone="ok"] .metric-detail { color: var(--ok-fg); font-weight: 600; }
    .metric[data-tone="warn"] .metric-detail { color: var(--warn-fg); font-weight: 600; }
    .metric[data-tone="bad"] .metric-detail { color: var(--bad-fg); font-weight: 600; }
    .metric[data-code="NET"] { --metric-color: var(--metric-1); --metric-bg: var(--metric-1-soft); }
    .metric[data-code="MOD"] { --metric-color: var(--metric-2); --metric-bg: var(--metric-2-soft); }
    .metric[data-code="RUN"] { --metric-color: var(--metric-3); --metric-bg: var(--metric-3-soft); }
    .metric[data-code="DUE"] { --metric-color: var(--metric-4); --metric-bg: var(--metric-4-soft); }
    .metric[data-code="ART"] { --metric-color: var(--metric-5); --metric-bg: var(--metric-5-soft); }
    .metric[data-code="LOG"] { --metric-color: var(--metric-6); --metric-bg: var(--metric-6-soft); }

    .ops-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.5fr) minmax(380px, 0.85fr);
      gap: 14px;
      align-items: stretch;
    }
    .runs-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 14px;
      margin-top: 14px;
      align-items: stretch;
    }
    .detail-surface { margin-top: 14px; }

    .live-log {
      min-height: 320px;
      max-height: 460px;
      margin: 0;
      background: linear-gradient(180deg, var(--terminal-bg-2) 0%, var(--terminal-bg) 100%);
      color: var(--terminal-fg);
      border: 1px solid var(--terminal-line);
      border-radius: var(--radius-sm);
      padding: 14px 16px;
      box-shadow:
        inset 3px 0 0 rgba(34, 197, 94, 0.55),
        inset 0 1px 0 rgba(255, 255, 255, 0.04);
      font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11.5px;
      line-height: 1.55;
    }
    .log-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 0 10px;
      flex-wrap: wrap;
    }
    .log-toolbar select {
      min-width: 220px;
      flex: 1 1 auto;
    }

    .detail-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin: 12px 0 14px;
    }
    .kv {
      border: 1px solid var(--line-soft);
      border-radius: var(--radius-sm);
      padding: 9px 11px;
      background: var(--panel-tint);
      min-width: 0;
    }
    .kv span {
      display: block;
      color: var(--muted);
      font-size: 10.5px;
      margin-bottom: 4px;
      letter-spacing: 0;
      text-transform: uppercase;
      font-weight: 600;
    }
    .kv strong { display: block; font-size: 12.5px; overflow-wrap: anywhere; color: var(--ink); font-weight: 600; }

    .log-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 12px;
    }
    .wide-log { grid-column: 1 / -1; }

    .empty {
      color: var(--muted);
      padding: 22px;
      text-align: center;
      border: 1px dashed var(--line-strong);
      border-radius: var(--radius-sm);
      background: var(--panel-tint);
      font-size: 13px;
    }
    .table-note { margin-top: 10px; color: var(--muted); font-size: 12px; padding: 0 4px; }
    .path-cell { max-width: 220px; overflow-wrap: anywhere; }
    .prompt-cell { min-width: 220px; max-width: 360px; }
    .id-button {
      max-width: 240px;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11.5px;
      padding: 5px 10px;
      background: var(--panel-tint);
      border-color: var(--line);
    }
    .id-button:hover { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-ink); }

    #detail > div:first-child { margin-bottom: 4px; }
    #detail > div:first-child .mono { font-size: 12.5px; color: var(--ink); background: var(--panel-tint); padding: 5px 10px; border-radius: 6px; border: 1px solid var(--line); display: inline-block; }

    @media (max-width: 1280px) {
      .summary-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .ops-grid, .runs-grid { grid-template-columns: minmax(0, 1fr); }
      .live-log { min-height: 280px; }
      .detail-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 720px) {
      .topbar-inner { align-items: stretch; flex-direction: column; padding: 12px 14px; }
      .topbar .toolbar { justify-content: flex-start; }
      main { padding: 14px; }
      .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
      .detail-grid, .log-grid { grid-template-columns: minmax(0, 1fr); }
      .brand { min-width: 0; }
      input, select { min-width: 0; width: 100%; }
      .surface-body { padding: 12px; }
      .metric { min-height: 92px; padding: 12px 13px; }
      .metric-value { font-size: 22px; }
    }
`;
