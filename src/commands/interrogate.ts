import * as vscode from 'vscode';
import { AppContext } from '../appContext';
import { SpecHealth } from '../types';
import { resolveCodebaseContext } from '../utils/codebaseContext';
import { showSpecHealthPanel } from '../views/specHealthPanel';

/**
 * /ariadne-interrogate — runs Spec Health on a spec: finds Ambiguities, Gaps, and
 * Conflicts via the Context Engine, persists the result on the spec, and
 * shows it in a panel.
 */
export async function runInterrogate(app: AppContext, specId?: string): Promise<SpecHealth | undefined> {
  const { specs, requirements } = app.store.getState();
  let id = specId;

  if (!id) {
    if (specs.length === 0) {
      vscode.window.showWarningMessage('Ariadne: No specs yet. Generate a spec first.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      specs.map((s) => ({ label: s.title, description: s.status, id: s.id })),
      { title: 'Ariadne: Select a spec to check' },
    );
    if (!picked) return undefined;
    id = picked.id;
  }

  const spec = specs.find((s) => s.id === id);
  if (!spec) {
    vscode.window.showWarningMessage('Ariadne: Spec not found.');
    return undefined;
  }

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Ariadne: Checking spec health for "${spec.title}"…` },
    async () => {
      try {
        const markdown = await app.store.getSpecMarkdown(spec);
        const linkedReqs = requirements.filter((r) => spec.requirementIds.includes(r.id));
        const codebaseSummary = await resolveCodebaseContext(app);
        const health = await app.engine.interrogate(spec, markdown, linkedReqs, codebaseSummary);
        await app.store.updateSpec(spec.id, { health });
        await app.store.logActivity(
          'spec-health-checked',
          `Spec health for "${spec.title}": ${health.ambiguities.length} ambiguities, ${health.gaps.length} gaps, ${health.conflicts.length} conflicts`,
        );
        showSpecHealthPanel(app, spec.title, health);
        return health;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Ariadne: Spec health check failed — ${message}`);
        app.output.appendLine(`[interrogate] ${message}`);
        return undefined;
      }
    },
  );
}
