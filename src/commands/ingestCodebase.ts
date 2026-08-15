import * as vscode from 'vscode';
import { AppContext } from '../appContext';
import { ingestCodebase } from '../contextEngine/codebaseIngestion';
import { nowIso } from '../types';

/**
 * Ariadne: Ingest Codebase — hands the repo to the active Task Execution
 * backend (Claude Code, VS Code LM, or Ollama) to build a persisted
 * "codebase understanding" doc, used in place of the cheap heuristic summary
 * everywhere else in the extension. Manual only — never runs automatically.
 */
export async function runIngestCodebase(app: AppContext): Promise<void> {
  const backend = app.backends.getActiveBackend();
  if (!backend) {
    vscode.window.showErrorMessage('Ariadne: No AI backend selected. Run "Ariadne: Select AI Backend".');
    return;
  }
  const available = await backend.isAvailable();
  if (!available) {
    vscode.window.showErrorMessage(`Ariadne: ${backend.name} is not available. ${backend.unavailableHint}`);
    return;
  }

  if (await app.store.hasLocalEditsSinceIngest()) {
    const choice = await vscode.window.showWarningMessage(
      'Ariadne: codebase-context.md has been edited by hand since the last ingestion. Re-ingesting will overwrite those edits.',
      { modal: true },
      'Overwrite',
    );
    if (choice !== 'Overwrite') return;
  }

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  app.output.show(true);
  app.output.appendLine(`\n=== Ingesting codebase with ${backend.name} ===`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Ariadne: Building codebase understanding with ${backend.name}…`,
      cancellable: true,
    },
    async (_progress, token) => {
      try {
        const result = await ingestCodebase(backend, cwd, token, (chunk) => app.output.append(chunk));
        app.output.appendLine(`\n--- ${backend.name} finished ---`);
        await app.store.saveCodebaseContext(
          {
            ingestedAt: nowIso(),
            backendId: backend.id,
            backendName: backend.name,
            gitCommit: result.gitCommit,
            fileCount: result.fileCount,
          },
          result.markdown,
        );
        vscode.window.showInformationMessage('Ariadne: Codebase understanding updated.');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        app.output.appendLine(`\n--- ${backend.name} error: ${message} ---`);
        vscode.window.showErrorMessage(`Ariadne: Codebase ingestion failed — ${message}`);
      }
    },
  );
}
