import * as vscode from 'vscode';
import { AppContext } from '../appContext';
import { Spec } from '../types';
import { summarizeWorkspace } from '../utils/codebaseContext';

/**
 * /ariadne-spec — turns selected Requirements into an engineering spec (Markdown
 * file under .ariadne/specs/) via the Context Engine, and links them in
 * traceability.
 */
export async function runGenerateSpec(app: AppContext, requirementIds?: string[]): Promise<Spec | undefined> {
  const { requirements } = app.store.getState();
  let ids = requirementIds;

  if (!ids || ids.length === 0) {
    if (requirements.length === 0) {
      vscode.window.showWarningMessage('Ariadne: No requirements yet. Run "Decompose Clipboard into Requirements" first.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      requirements.map((r) => ({
        label: r.title,
        description: `${r.type} · ${r.status}`,
        detail: r.description,
        id: r.id,
      })),
      { canPickMany: true, title: 'Ariadne: Select requirements to cover in this spec' },
    );
    if (!picked || picked.length === 0) return undefined;
    ids = picked.map((p) => p.id);
  }

  const selected = requirements.filter((r) => ids!.includes(r.id));
  if (selected.length === 0) {
    vscode.window.showWarningMessage('Ariadne: No matching requirements selected.');
    return undefined;
  }

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Ariadne: Generating spec…' },
    async () => {
      try {
        const codebaseSummary = await summarizeWorkspace();
        const generated = await app.engine.generateSpec(selected, codebaseSummary);
        const spec = await app.store.addSpec(
          {
            title: generated.title,
            requirementIds: selected.map((r) => r.id),
            acceptanceCriteria: generated.acceptanceCriteria,
          },
          generated.markdown,
        );
        await app.store.rebuildTraceability();
        vscode.window.showInformationMessage(`Ariadne: Generated spec "${spec.title}".`);
        return spec;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Ariadne: Spec generation failed — ${message}`);
        app.output.appendLine(`[generateSpec] ${message}`);
        return undefined;
      }
    },
  );
}
