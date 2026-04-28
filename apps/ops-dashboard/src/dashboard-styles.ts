export const DASHBOARD_STYLES = `    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f6f2;
      color: #18211f;
      --ink: #18211f;
      --ink-soft: #2c3935;
      --muted: #6d7771;
      --panel: rgba(255, 255, 252, 0.96);
      --panel-solid: #fffffc;
      --line: #d8dfd6;
      --line-soft: #e8ede6;
      --wash: #f8f9f4;
      --head: #f1f4ee;
      --accent: #0f766e;
      --accent-strong: #0a5f59;
      --accent-soft: #e8f4ef;
      --sage: #728a76;
      --sand: #d8c9a5;
      --ok-bg: #e4f6e7;
      --ok-fg: #19633a;
      --warn-bg: #fff1cf;
      --warn-fg: #815500;
      --bad-bg: #ffe7e5;
      --bad-fg: #982323;
      --shadow: 0 18px 42px rgba(35, 45, 38, 0.08), 0 2px 8px rgba(31, 41, 36, 0.04);
      --shadow-soft: 0 8px 22px rgba(35, 45, 38, 0.055);
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: linear-gradient(180deg, #fbfbf7 0%, #f4f6f1 48%, #edf2ed 100%); }
    .topbar { position: sticky; top: 0; z-index: 10; background: rgba(250, 251, 247, 0.9); color: var(--ink); border-bottom: 1px solid rgba(52, 68, 60, 0.13); backdrop-filter: blur(18px); }
    .topbar-inner { max-width: 1500px; margin: 0 auto; padding: 13px 22px; display: flex; gap: 18px; align-items: center; justify-content: space-between; }
    .brand { min-width: 330px; display: flex; align-items: center; gap: 12px; }
    .brand-mark { width: 38px; height: 38px; border-radius: 8px; display: grid; place-items: center; color: #f8fbf7; background: linear-gradient(135deg, #172421 0%, #0f5c56 100%); box-shadow: inset 0 0 0 1px rgba(255,255,255,.15), 0 8px 18px rgba(15, 92, 86, .18); font-weight: 850; letter-spacing: 0; }
    .brand-copy { min-width: 0; }
    h1 { font-size: 17px; margin: 0; letter-spacing: 0; font-weight: 820; }
    .brand-subtitle { margin-top: 3px; color: var(--muted); font-size: 12px; }
    main { max-width: 1500px; margin: 0 auto; padding: 18px 22px 30px; }
    section { min-width: 0; }
    h2 { font-size: 15px; line-height: 1.25; margin: 0; letter-spacing: 0; font-weight: 780; }
    h3 { font-size: 13px; margin: 16px 0 8px; color: var(--ink-soft); }
    button { border: 1px solid #b8c5be; background: #fffefb; color: var(--ink); border-radius: 8px; padding: 7px 11px; cursor: default; font: inherit; font-size: 13px; white-space: nowrap; box-shadow: 0 1px 1px rgba(20,33,36,.03); transition: background .16s ease, border-color .16s ease, color .16s ease, transform .16s ease, box-shadow .16s ease; }
    button[data-run], button[data-enable], button[data-runmodule], button[data-artifact-run], button[data-promote], #refresh, #dispatch, #logPause, #logClear { cursor: pointer; }
    button[data-run]:hover, button[data-enable]:hover, button[data-runmodule]:hover, button[data-artifact-run]:hover, button[data-promote]:hover, #refresh:hover, #dispatch:hover, #logPause:hover, #logClear:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(35, 45, 38, .08); }
    button.primary { background: var(--accent-strong); color: #fff; border-color: var(--accent-strong); box-shadow: 0 8px 18px rgba(10, 95, 89, .18); }
    button.primary:hover { background: #084f4a; border-color: #084f4a; }
    button.ghost { background: #fffefb; color: var(--ink); border-color: #cbd7d1; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    button:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid rgba(15, 118, 110, .18); outline-offset: 2px; }
    table { width: 100%; border-collapse: collapse; background: var(--panel-solid); }
    th, td { text-align: left; vertical-align: middle; padding: 10px 12px; border-bottom: 1px solid var(--line-soft); font-size: 12.5px; }
    th { background: #f7f8f4; font-weight: 780; color: #66716b; position: sticky; top: 0; z-index: 1; font-size: 11.5px; }
    tbody tr:nth-child(even) td { background: #fcfdf9; }
    tr:hover td { background: #f5faf6; }
    input, select { padding: 7px 10px; border-radius: 8px; border: 1px solid #bac8c1; font: inherit; font-size: 13px; min-width: 210px; background: #fffefb; color: var(--ink); box-shadow: inset 0 1px 0 rgba(31, 41, 36, .02); }
    a { color: var(--accent); }
    pre { white-space: pre-wrap; word-break: break-word; background: #101714; color: #e2ebe4; padding: 12px; overflow: auto; max-height: 300px; border-radius: 8px; font-size: 12px; line-height: 1.5; border: 1px solid #25332e; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .topbar .toolbar { justify-content: flex-end; }
    .muted { color: var(--muted); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .status { display: inline-flex; align-items: center; justify-content: center; min-width: 68px; padding: 3px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 760; text-align: center; background: #edf1ed; color: #5b6964; border: 1px solid rgba(72, 88, 79, .08); }
    .ok { background: var(--ok-bg); color: var(--ok-fg); }
    .bad { background: var(--bad-bg); color: var(--bad-fg); }
    .warn { background: var(--warn-bg); color: var(--warn-fg); }
    .connection { min-width: 76px; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .surface { background: var(--panel); border: 1px solid rgba(68, 87, 75, .16); border-radius: 8px; box-shadow: var(--shadow); min-width: 0; overflow: hidden; }
    .surface-head { min-height: 62px; padding: 14px 15px 12px; display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; border-bottom: 1px solid var(--line-soft); background: linear-gradient(180deg, rgba(255,255,252,.86), rgba(250,251,246,.72)); }
    .surface-title { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .surface-kicker { font-size: 10.5px; color: #708174; text-transform: uppercase; letter-spacing: .08em; font-weight: 840; }
    .surface-body { padding: 12px; min-width: 0; }
    .table-scroll { overflow: auto; border: 1px solid var(--line-soft); border-radius: 8px; background: var(--panel-solid); box-shadow: inset 0 1px 0 rgba(255,255,255,.75); }
    .runs-scroll { max-height: 500px; }
    .modules-scroll { max-height: 520px; }
    .artifact-scroll { max-height: 500px; }
    .summary-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
    .metric { position: relative; background: rgba(255,255,252,.9); border: 1px solid rgba(63, 83, 72, .14); border-top: 3px solid var(--sage); border-radius: 8px; padding: 12px 13px; min-height: 86px; display: flex; flex-direction: column; gap: 8px; box-shadow: var(--shadow-soft); overflow: hidden; }
    .metric::after { content: ""; position: absolute; inset: auto 12px 0 12px; height: 1px; background: linear-gradient(90deg, transparent, rgba(15,118,110,.24), transparent); }
    .metric-label-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .metric-label { color: var(--muted); font-size: 11.5px; font-weight: 780; }
    .metric-code { flex: 0 0 auto; border: 1px solid #d8e4dd; background: #f1f7f3; color: #4d6659; border-radius: 999px; padding: 1px 6px; font-size: 10px; font-weight: 820; }
    .metric-value { font-size: 22px; font-weight: 830; line-height: 1.05; overflow-wrap: anywhere; color: #17221f; }
    .metric-detail { color: var(--muted); font-size: 11.5px; line-height: 1.35; overflow-wrap: anywhere; }
    .metric[data-tone="ok"] { border-top-color: #3c9f64; }
    .metric[data-tone="warn"] { border-top-color: #c8942e; background: #fffef8; }
    .metric[data-tone="bad"] { border-top-color: #c24141; background: #fffafa; }
    .ops-grid { display: grid; grid-template-columns: minmax(0, 1.48fr) minmax(360px, .82fr); gap: 14px; align-items: start; }
    .runs-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; margin-top: 14px; align-items: start; }
    .detail-surface { margin-top: 14px; }
    .live-log { min-height: 304px; max-height: 430px; margin: 10px 0 0; background: #111714; color: #d8e7df; border: 1px solid #24342e; box-shadow: inset 3px 0 0 rgba(58, 156, 108, .65), inset 0 0 0 1px rgba(255,255,255,.02); }
    .detail-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 10px 0 14px; }
    .kv { border: 1px solid var(--line-soft); border-radius: 8px; padding: 8px 10px; background: #fbfcf7; min-width: 0; }
    .kv span { display: block; color: var(--muted); font-size: 11px; margin-bottom: 3px; }
    .kv strong { display: block; font-size: 12.5px; overflow-wrap: anywhere; }
    .log-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
    .wide-log { grid-column: 1 / -1; }
    .empty { color: var(--muted); padding: 18px; text-align: center; border: 1px dashed var(--line); border-radius: 8px; background: #fbfcf7; }
    .table-note { margin-top: 8px; color: var(--muted); font-size: 12px; }
    .path-cell { max-width: 220px; overflow-wrap: anywhere; }
    .prompt-cell { min-width: 220px; max-width: 360px; }
    .id-button { max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
    @media (max-width: 1200px) {
      .summary-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .ops-grid, .runs-grid { grid-template-columns: minmax(0, 1fr); }
      .live-log { min-height: 260px; }
    }
    @media (max-width: 720px) {
      .topbar-inner { align-items: stretch; flex-direction: column; }
      .topbar .toolbar { justify-content: flex-start; }
      main { padding: 12px; }
      .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .detail-grid, .log-grid { grid-template-columns: minmax(0, 1fr); }
      .brand { min-width: 0; }
      input, select { min-width: 0; width: 100%; }
    }
`;
