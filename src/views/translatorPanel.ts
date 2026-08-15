import * as vscode from 'vscode';
import { AppContext } from '../appContext';
import { decomposeText } from '../commands/decompose';
import { runGenerateSpec } from '../commands/generateSpec';
import { runGenerateTasks } from '../commands/generateTasks';
import { runIngestCodebase } from '../commands/ingestCodebase';
import { runInterrogate } from '../commands/interrogate';
import { runTaskWithBackend } from '../commands/runTask';
import { selectBackend } from '../commands/misc';
import { OllamaChatMessage } from '../backends/ollamaAdapter';
import { RequirementType } from '../types';
import { codiconsDirUri, cspFor, getNonce, localResourceRoots, relativeTime, SHARED_STYLE } from './webviewUtils';

interface InboundMessage {
  command: string;
  [key: string]: unknown;
}

interface StagedRequirement {
  title: string;
  description: string;
  type: RequirementType;
  tags?: string[];
}

/**
 * The "Translator" side panel: a requirements composer (paste, drag a
 * file, or type — review before anything is committed), Specs, Tasks, and an
 * Assistant chat tab, all in one webview view.
 */
export class TranslatorViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'ariadne.translatorView';
  private view: vscode.WebviewView | undefined;
  private assistantHistory: OllamaChatMessage[] = [];

  constructor(private readonly app: AppContext, private readonly extensionUri: vscode.Uri) {
    app.store.onDidChange(() => this.postState());
    app.backends.onDidChangeStatus(() => this.postState());
  }

  reveal(): void {
    this.view?.show?.(true);
  }

  /** Entry point for the command-palette "Decompose Clipboard into Requirements" action. */
  async startClipboardExtraction(): Promise<void> {
    this.reveal();
    const text = await vscode.env.clipboard.readText();
    if (!text.trim()) {
      vscode.window.showWarningMessage('Ariadne: Clipboard is empty. Copy some requirements text first, or type directly into the panel.');
      return;
    }
    this.post({ type: 'prefillAndExtract', text });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: localResourceRoots(this.extensionUri) };
    webviewView.webview.html = this.html(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: InboundMessage) => this.handleMessage(msg));

    this.app.backends.refreshAvailability().then(() => this.postState());
    this.postState();
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    try {
      switch (msg.command) {
        case 'ready':
        case 'refresh':
          this.postState();
          break;

        case 'requestClipboardText': {
          const text = await vscode.env.clipboard.readText();
          this.post({ type: 'clipboardText', text });
          break;
        }

        case 'extractRequirements':
          await this.handleExtract(msg.text as string);
          break;

        case 'commitRequirements': {
          const items = msg.items as StagedRequirement[];
          const cleaned = items
            .map((i) => ({ ...i, title: i.title.trim(), description: i.description.trim() }))
            .filter((i) => i.title && i.description);
          if (cleaned.length === 0) break;
          await this.app.store.addRequirements(cleaned.map((i) => ({ ...i, source: 'extracted' })));
          vscode.window.showInformationMessage(
            `Ariadne: Added ${cleaned.length} requirement${cleaned.length === 1 ? '' : 's'}.`,
          );
          break;
        }

        case 'addRequirementManual': {
          const title = (msg.title as string)?.trim();
          const description = (msg.description as string)?.trim();
          if (!title || !description) break;
          await this.app.store.addRequirements([
            { title, description, type: (msg.type as RequirementType) ?? 'functional', source: 'manual' },
          ]);
          break;
        }

        case 'deleteRequirement':
          await this.app.store.deleteRequirement(msg.id as string);
          break;

        case 'markVerified': {
          const { requirements } = this.app.store.getState();
          const req = requirements.find((r) => r.id === msg.id);
          if (req) {
            await this.app.store.updateRequirement(req.id, { status: req.status === 'verified' ? 'draft' : 'verified' });
            if (req.status !== 'verified') {
              await this.app.store.logActivity('requirement-verified', `Verified requirement "${req.title}"`);
            }
          }
          break;
        }

        case 'generateSpec':
          await runGenerateSpec(this.app, msg.ids as string[]);
          break;
        case 'openSpec': {
          const spec = this.app.store.getState().specs.find((s) => s.id === msg.id);
          if (spec) await vscode.window.showTextDocument(this.app.store.specFileUri(spec), { preview: true });
          break;
        }
        case 'generateTasks':
          await runGenerateTasks(this.app, msg.id as string);
          break;
        case 'interrogate':
          await runInterrogate(this.app, msg.id as string);
          break;
        case 'runTask':
          await runTaskWithBackend(this.app, msg.id as string, msg.backendId as string | undefined);
          break;
        case 'selectBackend':
          await selectBackend(this.app);
          break;
        case 'openFile':
          await vscode.commands.executeCommand('ariadne.openFile', msg.path as string);
          break;
        case 'openDashboard':
          await vscode.commands.executeCommand('ariadne.openDashboard');
          break;
        case 'openTraceabilityGraph':
          await vscode.commands.executeCommand('ariadne.openTraceabilityGraph');
          break;
        case 'ingestCodebase':
          await runIngestCodebase(this.app);
          break;
        case 'openCodebaseContext':
          await vscode.window.showTextDocument(this.app.store.codebaseContextFileUri(), { preview: true });
          break;
        case 'setApiKey':
          await this.app.engine.setApiKey();
          break;
        case 'assistantSend':
          await this.handleAssistantSend(msg.text as string);
          break;
        default:
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Ariadne: ${message}`);
    }
  }

  private async handleExtract(text: string): Promise<void> {
    if (!text?.trim()) return;
    try {
      const items = await decomposeText(this.app, text);
      this.post({ type: 'extractionResult', items });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: 'extractionError', message });
    }
  }

  private async handleAssistantSend(text: string): Promise<void> {
    if (!text?.trim()) return;
    const available = await this.app.backends.ollama.isAvailable();
    if (!available) {
      this.post({ type: 'assistantError', message: this.app.backends.ollama.unavailableHint });
      return;
    }
    const { requirements, specs, tasks } = this.app.store.getState();
    const summary = [
      `Requirements (${requirements.length}): ${requirements.slice(0, 20).map((r) => `${r.title} [${r.status}]`).join('; ') || 'none'}`,
      `Specs (${specs.length}): ${specs.slice(0, 20).map((s) => s.title).join('; ') || 'none'}`,
      `Tasks (${tasks.length}): ${tasks.slice(0, 20).map((t) => `${t.title} [${t.status}]`).join('; ') || 'none'}`,
    ].join('\n');
    if (this.assistantHistory.length === 0) {
      this.assistantHistory.push({
        role: 'system',
        content:
          `You are the Assistant, embedded in a VS Code extension that tracks requirements, specs, and tasks for a forward-deployed engineering project. Answer questions about the project below using only the context given; say when you don't know. Current project state:\n\n${summary}`,
      });
    }
    this.assistantHistory.push({ role: 'user', content: text });
    try {
      const reply = await this.app.backends.ollama.chat(this.assistantHistory);
      this.assistantHistory.push({ role: 'assistant', content: reply });
      this.post({ type: 'assistantMessage', text: reply });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: 'assistantError', message });
    }
  }

  private post(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  private postState(): void {
    const { requirements, specs, tasks, codebaseContext } = this.app.store.getState();
    const statuses = this.app.backends.getStatuses().map((s) => ({
      id: s.backend.id,
      name: s.backend.name,
      available: s.available,
      hint: s.backend.unavailableHint,
    }));
    this.post({
      type: 'state',
      requirements,
      specs,
      tasks,
      backends: statuses,
      activeBackendId: this.app.backends.activeBackendId,
      codebaseContext: codebaseContext
        ? { ingestedAgo: relativeTime(codebaseContext.ingestedAt), backendName: codebaseContext.backendName }
        : undefined,
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const codiconsDir = codiconsDirUri(webview, this.extensionUri);
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${cspFor(webview, nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${codiconsDir}/codicon.css" rel="stylesheet" />
<style nonce="${nonce}">${SHARED_STYLE}${STYLE}</style>
</head>
<body>
${BODY}
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
  }
}

const STYLE = `
  body { background: var(--vscode-sideBar-background); }

  .topbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 8px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    position: sticky; top: 0; background: var(--vscode-sideBar-background); z-index: 10;
  }
  .backend-pill {
    display: inline-flex; align-items: center; gap: 6px;
    background: transparent; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
    border-radius: var(--r-sm); padding: 3px 8px 3px 6px; font-size: 11px; color: var(--vscode-foreground);
  }
  .backend-pill:hover { background: var(--vscode-toolbar-hoverBackground); }
  .backend-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
  .backend-dot.on { background: var(--status-color, var(--vscode-testing-iconPassed)); box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-testing-iconPassed, #2ea043) 25%, transparent); }
  .backend-dot.off { background: var(--vscode-descriptionForeground); opacity: 0.5; }
  .topbar-actions { display: flex; gap: 2px; }

  .status-strip {
    display: flex; align-items: center; gap: 6px; padding: 4px 8px;
    font-size: 10.5px; color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    position: sticky; top: 33px; background: var(--vscode-sideBar-background); z-index: 9;
  }
  .status-strip .codicon { font-size: 11px; flex: none; }
  .status-strip a { margin-left: auto; font-size: 10.5px; flex: none; }

  .tabs { display: flex; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); position: sticky; top: 55px; background: var(--vscode-sideBar-background); z-index: 9; }
  .tab {
    flex: 1; padding: 7px 2px 6px; text-align: center; cursor: pointer;
    font-size: 11px; font-weight: 500; opacity: 0.65; border-bottom: 2px solid transparent;
    display: flex; align-items: center; justify-content: center; gap: 5px;
  }
  .tab:hover { opacity: 0.9; background: var(--vscode-toolbar-hoverBackground); }
  .tab .codicon { font-size: 13px; }
  .tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
  .tab-count {
    font-size: 9.5px; font-family: var(--mono); background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    border-radius: var(--r-badge); padding: 0 5px; min-width: 14px; line-height: 15px;
  }
  .tab.active .tab-count { background: var(--vscode-focusBorder); color: var(--vscode-editor-background); }

  .panel { display: none; padding: 10px 10px 4px; }
  .panel.active { display: block; }

  /* ---- Composer ---- */
  .composer {
    border: 1px dashed var(--vscode-widget-border, rgba(128,128,128,0.4));
    border-radius: var(--r-sm); padding: 10px; margin-bottom: 12px; transition: border-color 0.12s, background 0.12s;
  }
  .composer.drag { border-color: var(--vscode-focusBorder); background: color-mix(in srgb, var(--vscode-focusBorder) 6%, transparent); border-style: solid; }
  .composer-header { display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; margin-bottom: 7px; }
  .composer-header .codicon { color: var(--vscode-charts-blue, #3987e5); font-size: 13px; }
  .composer textarea { width: 100%; min-height: 64px; resize: vertical; }
  .composer-toolbar { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; gap: 6px; flex-wrap: wrap; }
  .composer-toolbar-left { display: flex; gap: 4px; }
  .file-label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
  .composer-error {
    margin-top: 8px; padding: 6px 8px; border-radius: var(--r-sm); font-size: 11.5px;
    background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-inputValidation-errorBorder, transparent);
  }
  .composer-error.composer-info {
    background: var(--vscode-inputValidation-infoBackground, var(--vscode-textBlockQuote-background));
    color: var(--vscode-foreground);
    border-color: var(--vscode-inputValidation-infoBorder, transparent);
  }
  .manual-toggle { font-size: 11px; margin-bottom: 10px; display: inline-block; }
  .manual-form { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3)); border-radius: var(--r-sm); padding: 10px; margin-bottom: 12px; display: flex; flex-direction: column; gap: 6px; }
  .manual-form input, .manual-form textarea, .manual-form select { width: 100%; }
  .manual-form textarea { min-height: 44px; resize: vertical; }
  .manual-form-row { display: flex; gap: 6px; align-items: center; }
  .manual-form-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 2px; }

  /* ---- Staging ---- */
  .staging { border: 1px solid var(--vscode-focusBorder); border-radius: var(--r-sm); padding: 10px; margin-bottom: 14px; background: color-mix(in srgb, var(--vscode-focusBorder) 5%, transparent); }
  .staging-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .staging-title { font-size: 11.5px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .staging-title .codicon { color: var(--vscode-charts-blue, #3987e5); }
  .staging-actions { display: flex; gap: 4px; }
  .staged-item { background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); border-radius: var(--r-sm); padding: 8px; margin-bottom: 6px; }
  .staged-item-top { display: flex; gap: 6px; align-items: center; margin-bottom: 5px; }
  .staged-item-top input[type="text"] { flex: 1; font-weight: 600; }
  .staged-item textarea { width: 100%; min-height: 36px; resize: vertical; font-size: 11.5px; }
  .staging-footer { display: flex; justify-content: flex-end; margin-top: 4px; }

  /* ---- Cards ---- */
  .card-list { display: flex; flex-direction: column; gap: 7px; }
  .card {
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
    border-radius: var(--r-sm); padding: 9px 10px; background: var(--vscode-sideBarSectionHeader-background, transparent);
    transition: border-color 0.12s;
  }
  .card:hover { border-color: var(--vscode-focusBorder); }
  .card-row { display: flex; gap: 8px; }
  .card-select { padding-top: 2px; }
  .card-body { flex: 1; min-width: 0; }
  .card-chips { display: flex; gap: 5px; margin-bottom: 5px; flex-wrap: wrap; }
  .card-title { font-weight: 600; font-size: 12.5px; line-height: 1.35; margin-bottom: 2px; }
  .card-desc { font-size: 11.5px; opacity: 0.85; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .card-meta { font-size: 10.5px; opacity: 0.6; margin-top: 5px; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .card-meta .codicon { font-size: 11px; }
  .card-actions { display: flex; gap: 3px; margin-top: 7px; flex-wrap: wrap; }
  .card-actions button { font-size: 11px; }

  .selection-bar {
    position: sticky; bottom: 0; display: none; align-items: center; justify-content: space-between;
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    border-top: 1px solid var(--vscode-focusBorder); padding: 8px 10px; margin: 0 -10px; box-shadow: 0 -2px 8px rgba(0,0,0,0.15);
  }
  .selection-bar.visible { display: flex; }
  .selection-bar span { font-size: 11.5px; font-weight: 500; }
  .selection-bar-actions { display: flex; gap: 6px; }

  /* ---- Assistant: console/log style, not chat bubbles ---- */
  .chat-empty { padding: 30px 10px; }
  .chat-log { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; max-height: calc(100vh - 190px); overflow-y: auto; padding-bottom: 4px; }
  .chat-turn {
    padding: 6px 0 6px 10px;
    border-left: 3px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
  }
  .chat-turn.user { border-left-color: var(--vscode-charts-blue, #3987e5); }
  .chat-turn.error { border-left-color: var(--vscode-charts-red, #f14c4c); }
  .chat-role {
    font-family: var(--mono); font-size: 9.5px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.06em; opacity: 0.55; margin-bottom: 3px;
  }
  .chat-turn.user .chat-role { color: var(--vscode-charts-blue, #3987e5); opacity: 0.95; }
  .chat-turn.error .chat-role { color: var(--vscode-charts-red, #f14c4c); opacity: 0.95; }
  .chat-msg { font-size: 12px; white-space: pre-wrap; line-height: 1.55; }
  .chat-msg.error { color: var(--vscode-errorForeground); }
  .chat-msg.pending { opacity: 0.6; }
  .chat-input { display: flex; gap: 6px; align-items: flex-end; }
  .chat-input textarea { flex: 1; resize: none; min-height: 34px; max-height: 120px; }
  .chat-hint { font-size: 10.5px; opacity: 0.55; margin-top: 5px; }
`;

const BODY = `
<div class="topbar">
  <button class="backend-pill" id="btn-backend" title="Change AI backend">
    <span class="backend-dot off" id="backend-dot"></span>
    <span id="backend-name">Detecting backends…</span>
    <span class="codicon codicon-chevron-down"></span>
  </button>
  <div class="topbar-actions">
    <button class="ghost icon-only" id="btn-dashboard" title="Open Dashboard"><span class="codicon codicon-graph-line"></span></button>
    <button class="ghost icon-only" id="btn-graph" title="Open Traceability Graph"><span class="codicon codicon-type-hierarchy"></span></button>
    <button class="ghost icon-only" id="btn-ingest" title="Ingest Codebase (Build Context)"><span class="codicon codicon-database"></span></button>
    <button class="ghost icon-only" id="btn-refresh" title="Refresh"><span class="codicon codicon-refresh"></span></button>
  </div>
</div>

<div class="status-strip" id="codebase-status">
  <span class="codicon codicon-database"></span>
  <span id="codebase-status-text">Codebase understanding: not built yet</span>
  <a id="codebase-open-link" style="display:none;">Open</a>
</div>

<div class="tabs">
  <div class="tab active" data-tab="requirements"><span class="codicon codicon-checklist"></span>Requirements<span class="tab-count" id="count-requirements">0</span></div>
  <div class="tab" data-tab="specs"><span class="codicon codicon-file-text"></span>Specs<span class="tab-count" id="count-specs">0</span></div>
  <div class="tab" data-tab="tasks"><span class="codicon codicon-rocket"></span>Tasks<span class="tab-count" id="count-tasks">0</span></div>
  <div class="tab" data-tab="assistant"><span class="codicon codicon-comment-discussion"></span>Assistant</div>
</div>

<div id="panel-requirements" class="panel active">
  <div class="composer" id="composer">
    <div class="composer-header"><span class="codicon codicon-sparkle"></span>New requirements</div>
    <textarea id="composer-text" placeholder="Paste meeting notes, a client email, or a requirements doc — or drop a .txt/.md file here."></textarea>
    <div class="composer-toolbar">
      <div class="composer-toolbar-left">
        <button class="ghost" id="btn-paste"><span class="codicon codicon-clippy"></span>Paste from clipboard</button>
        <label class="ghost file-label"><span class="codicon codicon-cloud-upload"></span>Upload file<input type="file" id="file-input" accept=".txt,.md,.markdown" hidden /></label>
      </div>
      <button id="btn-extract"><span class="codicon codicon-sparkle"></span>Extract requirements</button>
    </div>
    <div class="composer-error" id="composer-error" style="display:none;"></div>
  </div>

  <a class="manual-toggle" id="manual-toggle"><span class="codicon codicon-add"></span> Add a requirement manually</a>
  <div class="manual-form" id="manual-form" style="display:none;">
    <input type="text" id="manual-title" placeholder="Title" />
    <textarea id="manual-desc" placeholder="Description"></textarea>
    <div class="manual-form-row">
      <span style="font-size:11px;opacity:0.7;">Type</span>
      <select id="manual-type">
        <option value="functional">Functional</option>
        <option value="non-functional">Non-functional</option>
        <option value="business">Business</option>
        <option value="technical">Technical</option>
      </select>
    </div>
    <div class="manual-form-actions">
      <button class="secondary" id="manual-cancel">Cancel</button>
      <button id="manual-add">Add requirement</button>
    </div>
  </div>

  <div class="staging" id="staging" style="display:none;">
    <div class="staging-header">
      <span class="staging-title"><span class="codicon codicon-sparkle"></span><span id="staging-count-text">0 found</span></span>
      <div class="staging-actions">
        <button class="ghost" id="staging-discard-all">Discard all</button>
      </div>
    </div>
    <div id="staging-list"></div>
    <div class="staging-footer">
      <button id="staging-commit"><span class="codicon codicon-check"></span>Add requirements</button>
    </div>
  </div>

  <div id="requirements-list" class="card-list"></div>
</div>

<div id="panel-specs" class="panel"><div id="specs-list" class="card-list"></div></div>
<div id="panel-tasks" class="panel"><div id="tasks-list" class="card-list"></div></div>

<div id="panel-assistant" class="panel">
  <div class="chat-log" id="chat-log"></div>
  <div class="chat-input">
    <textarea id="chat-text" placeholder="Ask about your requirements, specs, or tasks…"></textarea>
    <button class="icon-only" id="chat-send" title="Send"><span class="codicon codicon-send"></span></button>
  </div>
  <div class="chat-hint">Runs locally via Ollama — free, private, no API key.</div>
</div>

<div class="selection-bar" id="selection-bar">
  <span id="selection-count">0 selected</span>
  <div class="selection-bar-actions">
    <button class="secondary" id="selection-clear">Clear</button>
    <button id="selection-generate"><span class="codicon codicon-file-text"></span>Generate spec</button>
  </div>
</div>
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
let state = { requirements: [], specs: [], tasks: [], backends: [], activeBackendId: '' };
const selectedReqs = new Set();
let staged = [];
let pendingChatBubble = null;

function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'text') e.textContent = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  (children || []).forEach((c) => c && e.appendChild(c));
  return e;
}
function icon(name, extraClass) {
  return el('span', { class: 'codicon codicon-' + name + (extraClass ? ' ' + extraClass : '') });
}

/*
 * window.confirm()/alert()/prompt() are no-ops inside a VS Code webview (it
 * runs in a sandboxed iframe with no 'allow-modals'), so destructive actions
 * use a two-click in-page confirm instead: first click arms it, a second
 * click within the window fires the action. Clicking elsewhere disarms it.
 *
 * Cards (and their confirmButtons) are recreated on every re-render, so the
 * "clicking elsewhere disarms it" listener is registered ONCE at module
 * scope rather than once per button — otherwise every re-render would leak
 * another permanent document-level listener.
 */
let armedConfirm = null;
document.addEventListener('click', (e) => {
  if (armedConfirm && e.target !== armedConfirm.btn && !armedConfirm.btn.contains(e.target)) {
    armedConfirm.disarm();
  }
});

function confirmButton(label, iconName, onConfirm) {
  let timer = null;
  const btn = el('button', { class: 'ghost danger', title: label }, [icon(iconName)]);
  function disarm() {
    if (timer) clearTimeout(timer);
    timer = null;
    btn.classList.remove('confirming');
    btn.innerHTML = '';
    btn.appendChild(icon(iconName));
    btn.title = label;
    if (armedConfirm && armedConfirm.btn === btn) armedConfirm = null;
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (armedConfirm && armedConfirm.btn === btn) {
      disarm();
      onConfirm();
      return;
    }
    if (armedConfirm) armedConfirm.disarm();
    btn.classList.add('confirming');
    btn.innerHTML = '';
    btn.appendChild(icon('warning'));
    btn.appendChild(document.createTextNode('Confirm ' + label.toLowerCase()));
    btn.title = 'Click again to confirm';
    timer = setTimeout(disarm, 3000);
    armedConfirm = { btn, disarm };
  });
  return btn;
}

const TYPE_META = {
  'functional': { icon: 'symbol-method', label: 'Functional' },
  'non-functional': { icon: 'shield', label: 'Non-functional' },
  'business': { icon: 'briefcase', label: 'Business' },
  'technical': { icon: 'gear', label: 'Technical' },
};

/* ---------------- Tabs ---------------- */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
}

/* ---------------- Topbar ---------------- */
document.getElementById('btn-backend').addEventListener('click', () => vscode.postMessage({ command: 'selectBackend' }));
document.getElementById('btn-dashboard').addEventListener('click', () => vscode.postMessage({ command: 'openDashboard' }));
document.getElementById('btn-graph').addEventListener('click', () => vscode.postMessage({ command: 'openTraceabilityGraph' }));
document.getElementById('btn-ingest').addEventListener('click', () => vscode.postMessage({ command: 'ingestCodebase' }));
document.getElementById('btn-refresh').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
document.getElementById('codebase-open-link').addEventListener('click', () => vscode.postMessage({ command: 'openCodebaseContext' }));

/* ---------------- Composer ---------------- */
const composerEl = document.getElementById('composer');
const composerText = document.getElementById('composer-text');
const composerError = document.getElementById('composer-error');
const btnExtract = document.getElementById('btn-extract');

document.getElementById('btn-paste').addEventListener('click', () => vscode.postMessage({ command: 'requestClipboardText' }));
btnExtract.addEventListener('click', doExtract);

function doExtract() {
  const text = composerText.value;
  if (!text.trim()) return;
  composerError.style.display = 'none';
  btnExtract.disabled = true;
  btnExtract.innerHTML = '';
  btnExtract.appendChild(icon('loading', 'codicon-modifier-spin'));
  btnExtract.appendChild(document.createTextNode('Extracting…'));
  vscode.postMessage({ command: 'extractRequirements', text });
}
function resetExtractButton() {
  btnExtract.disabled = false;
  btnExtract.innerHTML = '';
  btnExtract.appendChild(icon('sparkle'));
  btnExtract.appendChild(document.createTextNode('Extract requirements'));
}

['dragover'].forEach((evt) => composerEl.addEventListener(evt, (e) => { e.preventDefault(); composerEl.classList.add('drag'); }));
['dragleave', 'drop'].forEach((evt) => composerEl.addEventListener(evt, () => composerEl.classList.remove('drag')));
composerEl.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) readFileIntoComposer(file);
});
document.getElementById('file-input').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) readFileIntoComposer(file);
});
function readFileIntoComposer(file) {
  const reader = new FileReader();
  reader.onload = () => { composerText.value = String(reader.result || ''); composerText.focus(); };
  reader.readAsText(file);
}

/* ---------------- Manual add ---------------- */
const manualForm = document.getElementById('manual-form');
document.getElementById('manual-toggle').addEventListener('click', () => {
  manualForm.style.display = manualForm.style.display === 'none' ? 'flex' : 'none';
  if (manualForm.style.display !== 'none') document.getElementById('manual-title').focus();
});
document.getElementById('manual-cancel').addEventListener('click', () => { manualForm.style.display = 'none'; });
document.getElementById('manual-add').addEventListener('click', () => {
  const title = document.getElementById('manual-title').value.trim();
  const description = document.getElementById('manual-desc').value.trim();
  const type = document.getElementById('manual-type').value;
  if (!title || !description) return;
  vscode.postMessage({ command: 'addRequirementManual', title, description, type });
  document.getElementById('manual-title').value = '';
  document.getElementById('manual-desc').value = '';
  manualForm.style.display = 'none';
});

/* ---------------- Staging ---------------- */
function renderStaging() {
  const box = document.getElementById('staging');
  const list = document.getElementById('staging-list');
  list.innerHTML = '';
  if (staged.length === 0) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  document.getElementById('staging-count-text').textContent = staged.length + (staged.length === 1 ? ' requirement found — review before adding' : ' requirements found — review before adding');

  staged.forEach((item, idx) => {
    const titleInput = el('input', { type: 'text' });
    titleInput.value = item.title;
    titleInput.addEventListener('input', () => { staged[idx].title = titleInput.value; });

    const typeSelect = el('select', {}, Object.keys(TYPE_META).map((t) => {
      const opt = el('option', { value: t, text: TYPE_META[t].label });
      if (t === item.type) opt.selected = true;
      return opt;
    }));
    typeSelect.addEventListener('change', () => { staged[idx].type = typeSelect.value; });

    const removeBtn = el('button', { class: 'ghost icon-only', title: 'Discard', onclick: () => { staged.splice(idx, 1); renderStaging(); } }, [icon('close')]);

    const descArea = el('textarea', {});
    descArea.value = item.description;
    descArea.addEventListener('input', () => { staged[idx].description = descArea.value; });

    list.appendChild(el('div', { class: 'staged-item' }, [
      el('div', { class: 'staged-item-top' }, [titleInput, typeSelect, removeBtn]),
      descArea,
    ]));
  });
}
document.getElementById('staging-discard-all').addEventListener('click', () => { staged = []; renderStaging(); });
document.getElementById('staging-commit').addEventListener('click', () => {
  if (staged.length === 0) return;
  vscode.postMessage({ command: 'commitRequirements', items: staged });
  staged = [];
  renderStaging();
});

/* ---------------- Selection bar ---------------- */
function updateSelectionBar() {
  const bar = document.getElementById('selection-bar');
  bar.classList.toggle('visible', selectedReqs.size > 0);
  document.getElementById('selection-count').textContent = selectedReqs.size + (selectedReqs.size === 1 ? ' selected' : ' selected');
}
document.getElementById('selection-clear').addEventListener('click', () => { selectedReqs.clear(); render(); });
document.getElementById('selection-generate').addEventListener('click', () => {
  if (selectedReqs.size === 0) return;
  vscode.postMessage({ command: 'generateSpec', ids: [...selectedReqs] });
});

/* ---------------- Assistant ---------------- */
document.getElementById('chat-send').addEventListener('click', sendChat);
document.getElementById('chat-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
function sendChat() {
  const ta = document.getElementById('chat-text');
  const text = ta.value.trim();
  if (!text) return;
  appendChat('user', text);
  pendingChatBubble = appendChat('assistant', '', true);
  vscode.postMessage({ command: 'assistantSend', text });
  ta.value = '';
}
function appendChat(role, text, pending, isError) {
  const log = document.getElementById('chat-log');
  const roleLabel = role === 'user' ? 'You' : 'Assistant';
  const row = el('div', { class: 'chat-turn ' + role + (isError ? ' error' : '') }, [
    el('div', { class: 'chat-role', text: roleLabel }),
    el('div', { class: 'chat-msg' + (pending ? ' pending' : '') + (isError ? ' error' : ''), text: pending ? 'Thinking…' : text }),
  ]);
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  return row.querySelector('.chat-msg');
}

/* ---------------- Message bus ---------------- */
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'state') { state = msg; render(); }
  else if (msg.type === 'clipboardText') { composerText.value = msg.text; composerText.focus(); }
  else if (msg.type === 'prefillAndExtract') { switchTab('requirements'); composerText.value = msg.text; doExtract(); }
  else if (msg.type === 'extractionResult') {
    resetExtractButton();
    if (msg.items.length === 0) {
      composerError.style.display = 'block';
      composerError.className = 'composer-error composer-info';
      composerError.textContent = 'No extractable requirements found in that text. Try adding more detail, or add one manually below.';
    } else {
      composerError.style.display = 'none';
      staged = msg.items.map((i) => ({ title: i.title, description: i.description, type: i.type, tags: i.tags }));
      composerText.value = '';
      renderStaging();
    }
  } else if (msg.type === 'extractionError') {
    composerError.className = 'composer-error';
    resetExtractButton();
    composerError.style.display = 'block';
    composerError.textContent = msg.message;
  } else if (msg.type === 'assistantMessage') {
    if (pendingChatBubble) { pendingChatBubble.classList.remove('pending'); pendingChatBubble.textContent = msg.text; pendingChatBubble = null; }
    else appendChat('assistant', msg.text);
  } else if (msg.type === 'assistantError') {
    if (pendingChatBubble) {
      pendingChatBubble.classList.remove('pending');
      pendingChatBubble.classList.add('error');
      pendingChatBubble.closest('.chat-turn').classList.add('error');
      pendingChatBubble.textContent = msg.message;
      pendingChatBubble = null;
    }
    else appendChat('assistant', msg.message, false, true);
  }
});

/* ---------------- Render ---------------- */
function render() {
  document.getElementById('count-requirements').textContent = state.requirements.length;
  document.getElementById('count-specs').textContent = state.specs.length;
  document.getElementById('count-tasks').textContent = state.tasks.length;
  renderBackendPill();
  renderCodebaseStatus();
  renderRequirements();
  renderSpecs();
  renderTasks();
  updateSelectionBar();
}

function renderCodebaseStatus() {
  const text = document.getElementById('codebase-status-text');
  const link = document.getElementById('codebase-open-link');
  if (state.codebaseContext) {
    text.textContent = 'Codebase understanding: ingested ' + state.codebaseContext.ingestedAgo + ' via ' + state.codebaseContext.backendName;
    link.style.display = 'inline';
  } else {
    text.textContent = 'Codebase understanding: not built yet';
    link.style.display = 'none';
  }
}

function renderBackendPill() {
  const active = state.backends.find((b) => b.id === state.activeBackendId);
  const dot = document.getElementById('backend-dot');
  const name = document.getElementById('backend-name');
  if (!active) { name.textContent = state.backends.length ? 'Select backend' : 'No backends found'; dot.className = 'backend-dot off'; return; }
  name.textContent = active.name;
  dot.className = 'backend-dot ' + (active.available ? 'on' : 'off');
}

function emptyState(iconName, title, desc) {
  return el('div', { class: 'empty-state' }, [icon(iconName), el('div', { class: 'empty-title', text: title }), el('div', { class: 'empty-desc', text: desc })]);
}

function typeChip(type) {
  const meta = TYPE_META[type] || TYPE_META.functional;
  return el('span', { class: 'chip type-chip type-' + type }, [icon(meta.icon), document.createTextNode(meta.label)]);
}
function statusChip(label, toneClass, iconName) {
  return el('span', { class: 'chip status-chip ' + toneClass }, [icon(iconName), document.createTextNode(label)]);
}

function renderRequirements() {
  const list = document.getElementById('requirements-list');
  list.innerHTML = '';
  if (state.requirements.length === 0) {
    list.appendChild(emptyState('inbox', 'No requirements yet', 'Paste text into the box above and click Extract, or add one manually.'));
    return;
  }
  state.requirements.slice().reverse().forEach((r) => {
    const checkbox = el('input', { type: 'checkbox' });
    checkbox.checked = selectedReqs.has(r.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedReqs.add(r.id); else selectedReqs.delete(r.id);
      updateSelectionBar();
    });
    const verified = r.status === 'verified';
    const card = el('div', { class: 'card accent-bar type-' + r.type }, [
      el('div', { class: 'card-row' }, [
        el('div', { class: 'card-select' }, [checkbox]),
        el('div', { class: 'card-body' }, [
          el('div', { class: 'card-chips' }, [
            typeChip(r.type),
            verified ? statusChip('Verified', 'status-good', 'pass-filled') : statusChip('Draft', 'status-neutral', 'circle-large-outline'),
          ]),
          el('div', { class: 'card-title', text: r.title }),
          el('div', { class: 'card-desc', text: r.description }),
          el('div', { class: 'card-actions' }, [
            el('button', { class: 'ghost', onclick: () => vscode.postMessage({ command: 'markVerified', id: r.id }) }, [icon(verified ? 'circle-large-outline' : 'pass'), document.createTextNode(verified ? 'Unverify' : 'Mark verified')]),
            confirmButton('Delete', 'trash', () => vscode.postMessage({ command: 'deleteRequirement', id: r.id })),
          ]),
        ]),
      ]),
    ]);
    list.appendChild(card);
  });
}

function renderSpecs() {
  const list = document.getElementById('specs-list');
  list.innerHTML = '';
  if (state.specs.length === 0) {
    list.appendChild(emptyState('file-text', 'No specs yet', 'Select requirements in the Requirements tab and click Generate spec.'));
    return;
  }
  state.specs.slice().reverse().forEach((s) => {
    const findings = s.health ? (s.health.ambiguities.length + s.health.gaps.length + s.health.conflicts.length) : null;
    let toneClass, healthChip;
    if (findings === null) { toneClass = 'status-neutral'; healthChip = statusChip('Not checked', toneClass, 'circle-large-outline'); }
    else if (findings === 0) { toneClass = 'status-good'; healthChip = statusChip('Healthy', toneClass, 'pass-filled'); }
    else { toneClass = 'status-warning'; healthChip = statusChip(findings + ' finding' + (findings === 1 ? '' : 's'), toneClass, 'warning'); }

    const taskCount = state.tasks.filter((t) => t.specId === s.id).length;
    const doneCount = state.tasks.filter((t) => t.specId === s.id && t.status === 'done').length;

    list.appendChild(el('div', { class: 'card accent-bar ' + toneClass }, [
      el('div', { class: 'card-body' }, [
        el('div', { class: 'card-chips' }, [statusChip(s.status, 'status-neutral', 'file-text'), healthChip]),
        el('div', { class: 'card-title', text: s.title }),
        el('div', { class: 'card-meta' }, [
          icon('checklist'), document.createTextNode(s.requirementIds.length + ' requirement' + (s.requirementIds.length === 1 ? '' : 's')),
          icon('law'), document.createTextNode(s.acceptanceCriteria.length + ' criteria'),
          taskCount ? icon('rocket') : null, taskCount ? document.createTextNode(doneCount + '/' + taskCount + ' tasks done') : null,
        ]),
        el('div', { class: 'card-actions' }, [
          el('button', { class: 'secondary', onclick: () => vscode.postMessage({ command: 'openSpec', id: s.id }) }, [icon('go-to-file'), document.createTextNode('Open spec')]),
          el('button', { class: 'secondary', onclick: () => vscode.postMessage({ command: 'generateTasks', id: s.id }) }, [icon('rocket'), document.createTextNode('Generate tasks')]),
          el('button', { class: 'secondary', onclick: () => vscode.postMessage({ command: 'interrogate', id: s.id }) }, [icon('search'), document.createTextNode('Check health')]),
        ]),
      ]),
    ]));
  });
}

function renderTasks() {
  const list = document.getElementById('tasks-list');
  list.innerHTML = '';
  if (state.tasks.length === 0) {
    list.appendChild(emptyState('rocket', 'No tasks yet', 'Open a spec in the Specs tab and click Generate tasks.'));
    return;
  }
  state.tasks.slice().reverse().forEach((t) => {
    let statusEl, toneClass;
    if (t.status === 'done') { toneClass = 'status-good'; statusEl = statusChip('Done', toneClass, 'pass-filled'); }
    else if (t.status === 'in-progress') { toneClass = 'status-warning'; statusEl = statusChip('In progress', toneClass, 'sync'); }
    else { toneClass = 'status-neutral'; statusEl = statusChip('To do', toneClass, 'circle-large-outline'); }

    const runBtn = el('button', { onclick: () => vscode.postMessage({ command: 'runTask', id: t.id, backendId: state.activeBackendId }) }, [
      icon(t.status === 'in-progress' ? 'loading' : 'play', t.status === 'in-progress' ? 'codicon-modifier-spin' : ''),
      document.createTextNode(t.status === 'done' ? 'Re-run' : t.status === 'in-progress' ? 'Running…' : 'Run with backend'),
    ]);
    runBtn.disabled = t.status === 'in-progress';

    list.appendChild(el('div', { class: 'card accent-bar ' + toneClass }, [
      el('div', { class: 'card-body' }, [
        el('div', { class: 'card-chips' }, [statusEl]),
        el('div', { class: 'card-title', text: t.title }),
        el('div', { class: 'card-desc', text: t.description }),
        el('div', { class: 'card-meta' }, [
          icon('law'), document.createTextNode(t.acceptanceCriteria.length + ' criteria'),
          icon('file'), document.createTextNode(t.files.length + ' file' + (t.files.length === 1 ? '' : 's') + ' linked'),
          t.lastRunBackend ? icon('server-process') : null, t.lastRunBackend ? document.createTextNode('last run: ' + t.lastRunBackend) : null,
        ]),
        el('div', { class: 'card-actions' }, [runBtn]),
      ]),
    ]));
  });
}

vscode.postMessage({ command: 'ready' });
`;
