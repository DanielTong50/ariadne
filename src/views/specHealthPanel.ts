import * as vscode from 'vscode';
import { AppContext } from '../appContext';
import { SpecHealth } from '../types';
import { codiconsDirUri, cspFor, escapeHtml, getNonce, localResourceRoots, SHARED_STYLE } from './webviewUtils';

const panels = new Map<string, vscode.WebviewPanel>();

/** Shows /ariadne-interrogate results: Ambiguities, Gaps, Conflicts. */
export function showSpecHealthPanel(app: AppContext, specTitle: string, health: SpecHealth): void {
  const key = specTitle;
  let panel = panels.get(key);
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
  } else {
    panel = vscode.window.createWebviewPanel('ariadne.specHealth', `Spec Health: ${specTitle}`, vscode.ViewColumn.Beside, {
      enableScripts: false,
      localResourceRoots: localResourceRoots(app.context.extensionUri),
    });
    panels.set(key, panel);
    panel.onDidDispose(() => panels.delete(key));
  }
  panel.webview.html = render(app, panel.webview, specTitle, health);
}

function section(iconName: string, title: string, items: string[], emptyLabel: string, tone: string): string {
  const body = items.length
    ? `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`
    : `<p class="empty">${escapeHtml(emptyLabel)}</p>`;
  return `<section class="finding-section">
    <h2><span class="dot ${tone}"></span><span class="codicon codicon-${iconName}"></span>${title}<span class="count">${items.length}</span></h2>
    ${body}
  </section>`;
}

function render(app: AppContext, webview: vscode.Webview, specTitle: string, health: SpecHealth): string {
  const total = health.ambiguities.length + health.gaps.length + health.conflicts.length;
  const nonce = getNonce();
  const codiconsDir = codiconsDirUri(webview, app.context.extensionUri);

  return /* html */ `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${cspFor(webview, nonce)}">
<link href="${codiconsDir}/codicon.css" rel="stylesheet" />
<style nonce="${nonce}">${SHARED_STYLE}${STYLE}</style>
</head>
<body>
  <div class="page">
    <header>
      <div class="eyebrow"><span class="codicon codicon-search"></span>Spec health</div>
      <h1>${escapeHtml(specTitle)}</h1>
      <div class="subtitle">Checked ${new Date(health.checkedAt).toLocaleString()}</div>
    </header>

    <div class="summary ${total === 0 ? 'summary-good' : 'summary-warn'}">
      <span class="codicon codicon-${total === 0 ? 'pass-filled' : 'warning'}"></span>
      <span>${
        total === 0
          ? 'No issues found — this spec looks implementation-ready.'
          : `${total} finding${total === 1 ? '' : 's'} across ambiguities, gaps, and conflicts.`
      }</span>
    </div>

    ${section('question', 'Ambiguities', health.ambiguities, 'No ambiguous statements found.', 'status-warning')}
    ${section('debug-disconnect', 'Gaps', health.gaps, 'No coverage gaps found.', 'status-neutral')}
    ${section('warning', 'Conflicts', health.conflicts, 'No conflicting statements found.', 'status-critical')}
  </div>
</body></html>`;
}

const STYLE = `
  body { background: var(--vscode-editor-background); }
  .page { max-width: 720px; margin: 0 auto; padding: 34px 40px 60px; }
  header { margin-bottom: 20px; }
  .eyebrow { display: flex; align-items: center; gap: 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-charts-blue, #3987e5); font-weight: 600; margin-bottom: 6px; }
  h1 { font-size: 19px; margin: 0 0 4px; font-weight: 600; }
  .subtitle { opacity: 0.6; font-size: 12px; }

  .summary {
    display: flex; align-items: center; gap: 9px; font-size: 12.5px; margin-bottom: 26px;
    padding: 10px 14px; border-radius: 8px; border: 1px solid transparent;
  }
  .summary .codicon { font-size: 15px; flex: none; }
  .summary-good { background: color-mix(in srgb, var(--vscode-testing-iconPassed, #2ea043) 12%, transparent); color: var(--vscode-foreground); border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #2ea043) 30%, transparent); }
  .summary-good .codicon { color: var(--vscode-testing-iconPassed, #2ea043); }
  .summary-warn { background: var(--vscode-textBlockQuote-background); }
  .summary-warn .codicon { color: var(--vscode-charts-yellow, #d29933); }

  .finding-section { margin-bottom: 24px; }
  .finding-section h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600;
    display: flex; align-items: center; gap: 7px; margin: 0 0 8px;
  }
  .finding-section h2 .codicon { font-size: 13px; }
  .count { opacity: 0.55; font-weight: normal; margin-left: 2px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--status-color); flex: none; }
  ul { margin: 0; padding-left: 20px; }
  li { margin-bottom: 7px; font-size: 12.5px; line-height: 1.55; }
  .empty { opacity: 0.55; font-size: 12px; font-style: italic; margin: 0; }
`;
