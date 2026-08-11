import * as vscode from 'vscode';
import { AppContext } from '../appContext';

export async function markVerified(app: AppContext, requirementId?: string): Promise<void> {
  const { requirements } = app.store.getState();
  let id = requirementId;
  if (!id) {
    const picked = await vscode.window.showQuickPick(
      requirements.map((r) => ({ label: r.title, description: r.status, id: r.id })),
      { title: 'Ariadne: Toggle requirement verified' },
    );
    if (!picked) return;
    id = picked.id;
  }
  const req = requirements.find((r) => r.id === id);
  if (!req) return;
  const nextStatus = req.status === 'verified' ? 'draft' : 'verified';
  await app.store.updateRequirement(req.id, { status: nextStatus });
  if (nextStatus === 'verified') {
    await app.store.logActivity('requirement-verified', `Verified requirement "${req.title}"`);
  }
}

export async function selectBackend(app: AppContext): Promise<void> {
  await app.backends.refreshAvailability();
  const statuses = app.backends.getStatuses();
  const picked = await vscode.window.showQuickPick(
    statuses.map((s) => ({
      label: `${s.available ? '$(check)' : '$(circle-slash)'} ${s.backend.name}`,
      description: s.available ? 'available' : 'unavailable',
      detail: s.available ? undefined : s.backend.unavailableHint,
      id: s.backend.id,
    })),
    { title: 'Ariadne: Select AI Backend for "Run with [Backend]"' },
  );
  if (!picked) return;
  await app.backends.setActiveBackendId(picked.id);
  vscode.window.showInformationMessage(`Ariadne: Active backend set to ${app.backends.getBackend(picked.id)?.name}.`);
}

export async function openFileByPath(relativeOrAbsolute: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const uri = relativeOrAbsolute.startsWith('/') || /^[A-Za-z]:\\/.test(relativeOrAbsolute)
    ? vscode.Uri.file(relativeOrAbsolute)
    : folder
      ? vscode.Uri.joinPath(folder.uri, relativeOrAbsolute)
      : vscode.Uri.file(relativeOrAbsolute);
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch {
    vscode.window.showWarningMessage(`Ariadne: Could not open "${relativeOrAbsolute}".`);
  }
}
