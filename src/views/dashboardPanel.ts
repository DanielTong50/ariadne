import * as vscode from 'vscode';
import { AppContext } from '../appContext';
import { ActivityEntry, ActivityKind } from '../types';
import { codiconsDirUri, cspFor, escapeHtml, getNonce, localResourceRoots, SHARED_STYLE } from './webviewUtils';

interface Kpi {
  label: string;
  value: string | number;
  unit?: string;
}

let panel: vscode.WebviewPanel | undefined;

/** Separate editor-tab dashboard: task progress, business KPIs, activity feed. */
export function openDashboard(app: AppContext): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    void render(app, panel);
    return;
  }
  const created = vscode.window.createWebviewPanel('ariadne.dashboard', 'Ariadne Dashboard', vscode.ViewColumn.Active, {
    enableScripts: false,
    localResourceRoots: localResourceRoots(app.context.extensionUri),
  });
  panel = created;
  const sub = app.store.onDidChange(() => void render(app, created));
  created.onDidDispose(() => {
    if (panel === created) panel = undefined;
    sub.dispose();
  });
  void render(app, created);
}

async function readKpis(app: AppContext): Promise<Kpi[] | undefined> {
  try {
    const uri = vscode.Uri.joinPath(app.store.fdeDir, 'kpis.json');
    const bytes = await vscode.workspace.fs.readFile(uri);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return Array.isArray(parsed) ? (parsed as Kpi[]) : undefined;
  } catch {
    return undefined;
  }
}

const ACTIVITY_ICON: Record<ActivityKind, string> = {
  'requirement-added': 'add',
  'requirement-verified': 'pass-filled',
  'spec-generated': 'file-text',
  'spec-health-checked': 'search',
  'tasks-generated': 'rocket',
  'task-run-started': 'play',
  'task-run-finished': 'pass-filled',
  'task-status-changed': 'sync',
};

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Status-segmented progress ring (done / in-progress / to-do), gapped per the mark spec. */
function progressRing(done: number, inProgress: number, todo: number): string {
  const total = done + inProgress + todo;
  const r = 52;
  const circumference = 2 * Math.PI * r;
  const GAP = 2.6;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const segments: Array<{ count: number; color: string }> = [
    { count: done, color: 'var(--vscode-testing-iconPassed, var(--vscode-charts-green, #2ea043))' },
    { count: inProgress, color: 'var(--vscode-charts-yellow, #d29933)' },
    { count: todo, color: 'var(--vscode-widget-border, rgba(128,128,128,0.35))' },
  ];

  let cursor = 0;
  const circles = total
    ? segments
        .filter((s) => s.count > 0)
        .map((s) => {
          const rawLen = (s.count / total) * circumference;
          const drawLen = Math.max(0, rawLen - GAP);
          const offset = -(cursor + GAP / 2);
          cursor += rawLen;
          return `<circle cx="60" cy="60" r="${r}" fill="none" stroke="${s.color}" stroke-width="11" stroke-linecap="round"
            stroke-dasharray="${drawLen} ${circumference - drawLen}" stroke-dashoffset="${offset}" />`;
        })
        .join('')
    : `<circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--vscode-widget-border, rgba(128,128,128,0.25))" stroke-width="11" />`;

  return `<svg width="132" height="132" viewBox="0 0 120 120" class="ring">
    <g transform="rotate(-90 60 60)">${circles}</g>
    <text x="60" y="56" text-anchor="middle" class="ring-value">${pct}%</text>
    <text x="60" y="74" text-anchor="middle" class="ring-caption">complete</text>
  </svg>`;
}

function meter(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  return `<div class="meter"><div class="meter-fill" style="width:${clamped}%"></div></div>`;
}

async function render(app: AppContext, target: vscode.WebviewPanel): Promise<void> {
  const { requirements, specs, tasks, activity } = app.store.getState();
  const kpis = await readKpis(app);

  const done = tasks.filter((t) => t.status === 'done').length;
  const inProgress = tasks.filter((t) => t.status === 'in-progress').length;
  const todo = tasks.filter((t) => t.status === 'todo').length;

  const verified = requirements.filter((r) => r.status === 'verified').length;
  const verifiedPct = requirements.length ? Math.round((verified / requirements.length) * 100) : 0;

  const reqWithSpec = new Set(requirements.filter((r) => specs.some((s) => s.requirementIds.includes(r.id))).map((r) => r.id));
  const reqWithSpecPct = requirements.length ? Math.round((reqWithSpec.size / requirements.length) * 100) : 0;

  const tasksLinked = tasks.filter((t) => t.requirementIds.length > 0).length;
  const tasksLinkedPct = tasks.length ? Math.round((tasksLinked / tasks.length) * 100) : 0;

  const nonce = getNonce();
  const codiconsDir = codiconsDirUri(target.webview, app.context.extensionUri);

  target.webview.html = /* html */ `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${cspFor(target.webview, nonce)}">
<link href="${codiconsDir}/codicon.css" rel="stylesheet" />
<style nonce="${nonce}">${SHARED_STYLE}${DASHBOARD_STYLE}</style>
</head>
<body>
  <div class="page">
    <header class="page-header">
      <h1><span class="codicon codicon-dashboard"></span>Ariadne Dashboard</h1>
      <div class="subtitle">Requirements &rarr; Specs &rarr; Tasks &rarr; Code, at a glance.</div>
    </header>

    ${stageStepper(requirements.length, specs.length, tasks.length, done)}

    <section class="overview-grid">
      <div class="card ring-card">
        ${progressRing(done, inProgress, todo)}
        <div class="ring-legend">
          <span class="legend-item"><span class="dot status-good"></span>${done} done</span>
          <span class="legend-item"><span class="dot status-warning"></span>${inProgress} in progress</span>
          <span class="legend-item"><span class="dot status-neutral"></span>${todo} to do</span>
        </div>
      </div>

      <div class="stat-grid">
        ${statTile('checklist', 'Requirements', String(requirements.length), `${verifiedPct}% verified`, verifiedPct)}
        ${statTile('file-text', 'Specs', String(specs.length), `${reqWithSpecPct}% of requirements covered`, reqWithSpecPct)}
        ${statTile('rocket', 'Tasks', String(tasks.length), `${tasksLinkedPct}% linked to requirements`, tasksLinkedPct)}
      </div>
    </section>

    <section>
      <h2><span class="codicon codicon-graph-line"></span>Business KPIs</h2>
      ${renderKpis(kpis)}
    </section>

    <section>
      <h2><span class="codicon codicon-history"></span>Activity</h2>
      ${renderFeed(activity)}
    </section>
  </div>
</body></html>`;
}

function stageStepper(reqCount: number, specCount: number, taskCount: number, doneCount: number): string {
  const stage = (iconName: string, value: number, label: string, accent = false) => `
    <div class="stage-pill${accent ? ' accent' : ''}">
      <span class="codicon codicon-${iconName}"></span>
      <div class="stage-text"><span class="stage-value">${value}</span><span class="stage-label">${label}</span></div>
    </div>`;
  const arrow = `<span class="codicon codicon-chevron-right stage-arrow"></span>`;
  return `<div class="stage-stepper">
    ${stage('checklist', reqCount, 'Requirements')}
    ${arrow}
    ${stage('file-text', specCount, 'Specs')}
    ${arrow}
    ${stage('rocket', taskCount, 'Tasks')}
    ${arrow}
    ${stage('pass-filled', doneCount, 'Done', true)}
  </div>`;
}

function statTile(iconName: string, label: string, value: string, sub: string, pct: number): string {
  return `<div class="card stat-tile">
    <div class="stat-tile-top">
      <span class="codicon codicon-${iconName}"></span>
      <span class="stat-label">${escapeHtml(label)}</span>
    </div>
    <div class="stat-value">${escapeHtml(value)}</div>
    <div class="stat-sub">${escapeHtml(sub)}</div>
    ${meter(pct)}
  </div>`;
}

function renderKpis(kpis: Kpi[] | undefined): string {
  if (!kpis || kpis.length === 0) {
    return `<div class="kpi-hint">
      <span class="codicon codicon-info"></span>
      No business KPIs configured yet. Add <code>.ariadne/kpis.json</code> with entries like
      <code>[{"label": "P95 latency", "value": 420, "unit": "ms"}]</code> to surface them here.
    </div>`;
  }
  return `<div class="stat-grid">${kpis
    .map(
      (k) => `<div class="card kpi-tile">
        <div class="stat-label">${escapeHtml(k.label)}</div>
        <div class="stat-value">${escapeHtml(String(k.value))}${k.unit ? `<span class="kpi-unit">${escapeHtml(k.unit)}</span>` : ''}</div>
      </div>`,
    )
    .join('')}</div>`;
}

function renderFeed(activity: ActivityEntry[]): string {
  if (activity.length === 0) {
    return `<div class="empty-state"><span class="codicon codicon-history"></span><div class="empty-title">No activity yet</div><div class="empty-desc">Actions you take in the Translator panel will show up here.</div></div>`;
  }
  const rows = activity
    .slice(0, 60)
    .map(
      (a) => `<div class="feed-row">
        <div class="feed-icon"><span class="codicon codicon-${ACTIVITY_ICON[a.kind] ?? 'circle-small'}"></span></div>
        <div class="feed-body">
          <div class="feed-message">${escapeHtml(a.message)}</div>
          <div class="feed-time">${relativeTime(a.timestamp)}</div>
        </div>
      </div>`,
    )
    .join('');
  return `<div class="feed">${rows}</div>`;
}

const DASHBOARD_STYLE = `
  body { background: var(--vscode-editor-background); }
  .page { max-width: 900px; margin: 0 auto; padding: 32px 40px 60px; }
  .page-header { margin-bottom: 22px; }
  .page-header h1 { font-size: 21px; margin: 0 0 4px; display: flex; align-items: center; gap: 10px; font-weight: 600; }
  .page-header h1 .codicon { font-size: 20px; color: var(--vscode-charts-blue, #3987e5); }
  .subtitle { opacity: 0.6; font-size: 12.5px; }

  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.75; margin: 30px 0 12px; display: flex; align-items: center; gap: 7px; font-weight: 600; }
  h2 .codicon { font-size: 13px; }

  .card {
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
    border-radius: 8px; background: var(--vscode-sideBarSectionHeader-background, transparent);
  }

  /* Stage stepper */
  .stage-stepper { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); border-radius: 8px; overflow-x: auto; }
  .stage-pill { display: flex; align-items: center; gap: 9px; padding: 4px 10px; border-radius: 6px; flex: none; }
  .stage-pill .codicon { font-size: 17px; color: var(--vscode-descriptionForeground); }
  .stage-pill.accent .codicon { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #2ea043)); }
  .stage-text { display: flex; flex-direction: column; line-height: 1.2; }
  .stage-value { font-size: 17px; font-weight: 600; }
  .stage-label { font-size: 10.5px; opacity: 0.65; text-transform: uppercase; letter-spacing: 0.03em; }
  .stage-arrow { opacity: 0.35; font-size: 14px; flex: none; }

  /* Overview: ring + stat tiles */
  .overview-grid { display: grid; grid-template-columns: minmax(200px, 280px) 1fr; gap: 14px; margin-top: 16px; }
  .ring-card { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px 10px; gap: 10px; }
  .ring { display: block; }
  .ring-value { font-size: 22px; font-weight: 600; fill: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  .ring-caption { font-size: 9px; fill: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.05em; font-family: var(--vscode-font-family); }
  .ring-legend { display: flex; flex-direction: column; gap: 5px; align-self: stretch; padding: 0 8px; }
  .legend-item { font-size: 11px; display: flex; align-items: center; gap: 6px; color: var(--vscode-descriptionForeground); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--status-color); flex: none; }

  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .stat-tile, .kpi-tile { padding: 13px 15px; }
  .stat-tile-top { display: flex; align-items: center; gap: 7px; margin-bottom: 8px; }
  .stat-tile-top .codicon { font-size: 14px; color: var(--vscode-charts-blue, #3987e5); }
  .stat-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.03em; opacity: 0.65; font-weight: 600; }
  .stat-value { font-size: 24px; font-weight: 600; line-height: 1.15; }
  .stat-sub { font-size: 10.5px; opacity: 0.6; margin-top: 3px; margin-bottom: 8px; }
  .kpi-unit { font-size: 12px; opacity: 0.6; margin-left: 3px; font-weight: 500; }

  .meter { height: 5px; border-radius: 3px; background: color-mix(in srgb, var(--vscode-charts-blue, #3987e5) 18%, transparent); overflow: hidden; }
  .meter-fill { height: 100%; background: var(--vscode-charts-blue, #3987e5); border-radius: 3px; }

  .kpi-hint { font-size: 12px; opacity: 0.75; line-height: 1.6; display: flex; gap: 8px; padding: 12px 14px; border: 1px dashed var(--vscode-widget-border, rgba(128,128,128,0.35)); border-radius: 8px; }
  .kpi-hint .codicon { margin-top: 1px; flex: none; }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; font-size: 11px; }

  /* Activity feed */
  .feed { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); border-radius: 8px; padding: 4px 16px; }
  .feed-row { display: flex; gap: 12px; padding: 10px 0; position: relative; }
  .feed-row:not(:last-child) { border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15)); }
  .feed-icon {
    width: 22px; height: 22px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .feed-icon .codicon { font-size: 12px; }
  .feed-body { flex: 1; min-width: 0; padding-top: 1px; }
  .feed-message { font-size: 12.5px; }
  .feed-time { font-size: 10.5px; opacity: 0.55; margin-top: 2px; }
`;
