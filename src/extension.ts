import * as vscode from 'vscode';
import { FdeDataStore } from './dataStore';
import { ContextEngine } from './contextEngine/contextEngine';
import { BackendManager } from './backends/backendManager';
import { AppContext } from './appContext';
import { TranslatorViewProvider } from './views/translatorPanel';
import { TraceabilityTreeProvider } from './views/traceabilityTree';
import { openDashboard } from './views/dashboardPanel';
import { openTraceabilityGraph } from './views/traceabilityGraphPanel';
import { runGenerateSpec } from './commands/generateSpec';
import { runGenerateTasks } from './commands/generateTasks';
import { runInterrogate } from './commands/interrogate';
import { runTaskWithBackend } from './commands/runTask';
import { markVerified, openFileByPath, selectBackend } from './commands/misc';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Ariadne');
  context.subscriptions.push(output);

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    context.subscriptions.push(
      vscode.commands.registerCommand('ariadne.focusTranslator', () =>
        vscode.window.showWarningMessage('Ariadne: Open a folder or workspace first.'),
      ),
    );
    vscode.window.showInformationMessage('Ariadne: Open a folder to start tracking requirements, specs, and tasks.');
    return;
  }
  // MVP scope: single-root workspaces. Multi-root support (one .ariadne/ per
  // folder, a folder switcher in the panel) is a natural Phase 3 follow-up.

  const store = new FdeDataStore(folder);
  await store.initialize();
  context.subscriptions.push(store);

  const engine = new ContextEngine(context);
  const backends = new BackendManager(context);
  context.subscriptions.push(backends);

  const app: AppContext = { context, store, engine, backends, output };

  const translatorProvider = new TranslatorViewProvider(app, context.extensionUri);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(TranslatorViewProvider.viewType, translatorProvider));

  const traceabilityProvider = new TraceabilityTreeProvider(app);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('ariadne.traceabilityView', traceabilityProvider));

  context.subscriptions.push(
    vscode.commands.registerCommand('ariadne.decompose', () => translatorProvider.startClipboardExtraction()),
    vscode.commands.registerCommand('ariadne.generateSpec', (ids?: string[]) => runGenerateSpec(app, ids)),
    vscode.commands.registerCommand('ariadne.generateTasks', (specId?: string) => runGenerateTasks(app, specId)),
    vscode.commands.registerCommand('ariadne.interrogate', (specId?: string) => runInterrogate(app, specId)),
    vscode.commands.registerCommand('ariadne.runTask', (taskId?: string, backendId?: string) =>
      runTaskWithBackend(app, taskId, backendId),
    ),
    vscode.commands.registerCommand('ariadne.markVerified', (reqId?: string) => markVerified(app, reqId)),
    vscode.commands.registerCommand('ariadne.selectBackend', () => selectBackend(app)),
    vscode.commands.registerCommand('ariadne.setApiKey', () => engine.setApiKey()),
    vscode.commands.registerCommand('ariadne.openDashboard', () => openDashboard(app)),
    vscode.commands.registerCommand('ariadne.openTraceabilityGraph', () => openTraceabilityGraph(app)),
    vscode.commands.registerCommand('ariadne.openFile', (path: string) => openFileByPath(path)),
    vscode.commands.registerCommand('ariadne.focusTranslator', () => translatorProvider.reveal()),
    vscode.commands.registerCommand('ariadne.refresh', async () => {
      await backends.refreshAvailability();
      traceabilityProvider.refresh();
    }),
  );

  // Auto-detect available backends (Claude Code, VS Code LM, Ollama) without blocking activation.
  void backends.refreshAvailability();
}

export function deactivate(): void {
  // All disposables were registered on context.subscriptions.
}
