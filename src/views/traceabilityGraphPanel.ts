import * as vscode from 'vscode';
import { AppContext } from '../appContext';
import { Requirement, RequirementType, Spec, Task } from '../types';
import { codiconsDirUri, cspFor, escapeHtml, getNonce, localResourceRoots, SHARED_STYLE } from './webviewUtils';

let panel: vscode.WebviewPanel | undefined;

const TYPE_META: Record<RequirementType, { icon: string; label: string }> = {
  functional: { icon: 'symbol-method', label: 'Functional' },
  'non-functional': { icon: 'shield', label: 'Non-functional' },
  business: { icon: 'briefcase', label: 'Business' },
  technical: { icon: 'gear', label: 'Technical' },
};

/** Separate editor-tab view: Requirement -> Spec -> Task -> Files as a connected chain, driven by .ariadne/traceability.json. */
export function openTraceabilityGraph(app: AppContext): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    panel.webview.html = render(app, panel.webview);
    return;
  }
  const created = vscode.window.createWebviewPanel('ariadne.traceabilityGraph', 'Ariadne Traceability Graph', vscode.ViewColumn.Active, {
    enableScripts: false,
    enableCommandUris: true,
    localResourceRoots: localResourceRoots(app.context.extensionUri),
  });
  panel = created;
  const sub = app.store.onDidChange(() => {
    created.webview.html = render(app, created.webview);
  });
  created.onDidDispose(() => {
    if (panel === created) panel = undefined;
    sub.dispose();
  });
  created.webview.html = render(app, created.webview);
}

function connector(): string {
  return `<span class="codicon codicon-chevron-right gconnector"></span>`;
}

function placeholderNode(iconName: string, label: string): string {
  return `<div class="gnode gnode-placeholder"><span class="codicon codicon-${iconName}"></span><span class="gnode-title">${escapeHtml(label)}</span></div>`;
}

function requirementNode(req: Requirement | undefined, fallbackId: string): string {
  if (!req) return placeholderNode('circle-slash', fallbackId);
  const verified = req.status === 'verified';
  const meta = TYPE_META[req.type];
  return `<div class="gnode accent-bar type-${req.type}">
    <div class="gnode-chips">
      <span class="chip type-chip type-${req.type}"><span class="codicon codicon-${meta.icon}"></span>${escapeHtml(meta.label)}</span>
      <span class="chip status-chip ${verified ? 'status-good' : 'status-neutral'}"><span class="codicon codicon-${verified ? 'pass-filled' : 'circle-large-outline'}"></span>${verified ? 'Verified' : 'Draft'}</span>
    </div>
    <div class="gnode-title">${escapeHtml(req.title)}</div>
  </div>`;
}

function specNode(spec: Spec | undefined): string {
  if (!spec) return placeholderNode('circle-slash', 'No spec');
  const findings = spec.health ? spec.health.ambiguities.length + spec.health.gaps.length + spec.health.conflicts.length : null;
  let tone: string, label: string, iconName: string;
  if (findings === null) { tone = 'status-neutral'; label = 'Not checked'; iconName = 'circle-large-outline'; }
  else if (findings === 0) { tone = 'status-good'; label = 'Healthy'; iconName = 'pass-filled'; }
  else { tone = 'status-warning'; label = `${findings} finding${findings === 1 ? '' : 's'}`; iconName = 'warning'; }
  return `<div class="gnode accent-bar ${tone}">
    <div class="gnode-chips">
      <span class="chip status-chip status-neutral"><span class="codicon codicon-file-text"></span>${escapeHtml(spec.status)}</span>
      <span class="chip status-chip ${tone}"><span class="codicon codicon-${iconName}"></span>${escapeHtml(label)}</span>
    </div>
    <div class="gnode-title">${escapeHtml(spec.title)}</div>
  </div>`;
}

function taskNode(task: Task | undefined): string {
  if (!task) return placeholderNode('circle-slash', 'No tasks yet');
  let tone: string, label: string, iconName: string;
  if (task.status === 'done') { tone = 'status-good'; label = 'Done'; iconName = 'pass-filled'; }
  else if (task.status === 'in-progress') { tone = 'status-warning'; label = 'In progress'; iconName = 'sync'; }
  else { tone = 'status-neutral'; label = 'To do'; iconName = 'circle-large-outline'; }
  return `<div class="gnode accent-bar ${tone}">
    <div class="gnode-chips">
      <span class="chip status-chip ${tone}"><span class="codicon codicon-${iconName}"></span>${escapeHtml(label)}</span>
    </div>
    <div class="gnode-title">${escapeHtml(task.title)}</div>
  </div>`;
}

function fileBadges(files: string[]): string {
  if (files.length === 0) return `<span class="gnode-empty">No files linked</span>`;
  return `<div class="gfile-group">${files
    .map(
      (f) =>
        `<a class="gfile" href="command:ariadne.openFile?${encodeURIComponent(JSON.stringify([f]))}"><span class="codicon codicon-file"></span>${escapeHtml(f)}</a>`,
    )
    .join('')}</div>`;
}

function branchRow(specHtml: string, taskHtml: string, filesHtml: string | null): string {
  const parts = [specHtml, connector(), taskHtml];
  if (filesHtml !== null) parts.push(connector(), filesHtml);
  return `<div class="branch-row">${parts.join('')}</div>`;
}

function render(app: AppContext, webview: vscode.Webview): string {
  const { requirements, specs, tasks, traceability } = app.store.getState();
  const nonce = getNonce();
  const codiconsDir = codiconsDirUri(webview, app.context.extensionUri);

  const groups = traceability.entries.map((entry) => {
    const req = requirements.find((r) => r.id === entry.requirementId);

    const specBranches = entry.specIds
      .map((id) => specs.find((s) => s.id === id))
      .filter((s): s is Spec => !!s)
      .map((spec) => ({
        spec,
        tasks: entry.taskIds.map((id) => tasks.find((t) => t.id === id)).filter((t): t is Task => !!t && t.specId === spec.id),
      }));
    const nestedTaskIds = new Set(specBranches.flatMap((b) => b.tasks.map((t) => t.id)));
    const looseTasks = entry.taskIds
      .map((id) => tasks.find((t) => t.id === id))
      .filter((t): t is Task => !!t && !nestedTaskIds.has(t.id));

    const rows: string[] = [];
    for (const branch of specBranches) {
      if (branch.tasks.length === 0) {
        rows.push(branchRow(specNode(branch.spec), taskNode(undefined), null));
      } else {
        for (const task of branch.tasks) {
          rows.push(branchRow(specNode(branch.spec), taskNode(task), fileBadges(task.files)));
        }
      }
    }
    for (const task of looseTasks) {
      rows.push(branchRow(specNode(undefined), taskNode(task), fileBadges(task.files)));
    }

    return `<div class="chain-group">
      <div class="chain-req">${requirementNode(req, entry.requirementId)}</div>
      <div class="chain-branches">${rows.join('')}</div>
    </div>`;
  });

  const body = groups.length
    ? groups.join('')
    : `<div class="empty-state">
        <span class="codicon codicon-type-hierarchy"></span>
        <div class="empty-title">No traceability links yet</div>
        <div class="empty-desc">Links appear once requirements are connected to specs, tasks, and files from the Translator panel.</div>
      </div>`;

  return /* html */ `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${cspFor(webview, nonce)}">
<link href="${codiconsDir}/codicon.css" rel="stylesheet" />
<style nonce="${nonce}">${SHARED_STYLE}${GRAPH_STYLE}</style>
</head>
<body>
  <div class="page">
    <header class="page-header">
      <div class="eyebrow"><span class="codicon codicon-type-hierarchy"></span>Traceability</div>
      <h1><span class="codicon codicon-type-hierarchy"></span>Traceability Graph</h1>
      <div class="subtitle">Requirements &rarr; Specs &rarr; Tasks &rarr; Code</div>
    </header>
    ${body}
  </div>
</body></html>`;
}

const GRAPH_STYLE = `
  body { background: var(--vscode-editor-background); }

  .chain-group { display: flex; margin-bottom: 22px; }
  .chain-group:last-child { margin-bottom: 0; }
  .chain-req { align-self: center; flex: none; margin-right: 16px; }
  .chain-branches {
    display: flex; flex-direction: column; gap: 10px; flex: 1; min-width: 0;
    border-left: 2px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
  }
  .branch-row { position: relative; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 2px 0 2px 18px; }
  .branch-row::before {
    content: ''; position: absolute; left: 0; top: 50%; width: 16px; height: 2px;
    background: var(--vscode-widget-border, rgba(128,128,128,0.3));
  }

  .gnode {
    display: inline-flex; flex-direction: column; gap: 4px;
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
    border-radius: var(--r-sm); padding: 6px 10px;
    background: var(--vscode-sideBarSectionHeader-background, transparent);
    max-width: 240px; flex: none;
  }
  .gnode-chips { display: flex; gap: 4px; flex-wrap: wrap; }
  .gnode-title { font-size: 11.5px; font-weight: 600; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gnode-placeholder { flex-direction: row; align-items: center; gap: 6px; border-style: dashed; opacity: 0.6; }
  .gnode-placeholder .codicon { font-size: 13px; }
  .gnode-placeholder .gnode-title { font-weight: 500; font-style: italic; }

  .gconnector { font-size: 13px; opacity: 0.4; flex: none; }

  .gfile-group { display: flex; flex-direction: column; gap: 3px; }
  .gfile {
    display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-family: var(--mono);
    color: var(--vscode-foreground); padding: 2px 0;
  }
  .gfile:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
  .gfile .codicon { font-size: 12px; opacity: 0.7; }
  .gnode-empty { font-size: 11px; opacity: 0.5; font-style: italic; }
`;
