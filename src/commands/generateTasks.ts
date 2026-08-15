import * as vscode from 'vscode';
import { AppContext } from '../appContext';
import { Task } from '../types';
import { resolveCodebaseContext } from '../utils/codebaseContext';

/**
 * /ariadne-tasks — turns a spec's acceptance criteria into discrete Tasks via the
 * Context Engine, linked back to the spec and its requirements.
 */
export async function runGenerateTasks(app: AppContext, specId?: string): Promise<Task[]> {
  const { specs } = app.store.getState();
  let id = specId;

  if (!id) {
    if (specs.length === 0) {
      vscode.window.showWarningMessage('Ariadne: No specs yet. Generate a spec first.');
      return [];
    }
    const picked = await vscode.window.showQuickPick(
      specs.map((s) => ({ label: s.title, description: s.status, id: s.id })),
      { title: 'Ariadne: Select a spec to break into tasks' },
    );
    if (!picked) return [];
    id = picked.id;
  }

  const spec = specs.find((s) => s.id === id);
  if (!spec) {
    vscode.window.showWarningMessage('Ariadne: Spec not found.');
    return [];
  }

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Ariadne: Generating tasks for "${spec.title}"…` },
    async () => {
      try {
        const markdown = await app.store.getSpecMarkdown(spec);
        const codebaseSummary = await resolveCodebaseContext(app);
        const generated = await app.engine.generateTasks(spec, markdown, codebaseSummary);
        if (generated.length === 0) {
          vscode.window.showInformationMessage('Ariadne: No tasks generated — the spec may need more detail.');
          return [];
        }
        const tasks = await app.store.addTasks(
          generated.map((t) => ({
            title: t.title,
            description: t.description,
            acceptanceCriteria: t.acceptanceCriteria,
            specId: spec.id,
            requirementIds: spec.requirementIds,
          })),
        );
        await app.store.rebuildTraceability();
        vscode.window.showInformationMessage(`Ariadne: Generated ${tasks.length} task(s) for "${spec.title}".`);
        return tasks;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Ariadne: Task generation failed — ${message}`);
        app.output.appendLine(`[generateTasks] ${message}`);
        return [];
      }
    },
  );
}
