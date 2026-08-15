import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { AppContext } from '../appContext';
import { Task } from '../types';
import { findRelevantFiles, resolveCodebaseContext } from '../utils/codebaseContext';

const execAsync = promisify(exec);

async function gitChangedFiles(cwd: string): Promise<Set<string>> {
  try {
    const { stdout } = await execAsync('git status --porcelain', { cwd, timeout: 5000 });
    const files = new Set<string>();
    for (const line of stdout.split('\n')) {
      const trimmed = line.slice(3).trim();
      if (trimmed) files.add(trimmed.replace(/^"|"$/g, ''));
    }
    return files;
  } catch {
    return new Set();
  }
}

async function buildPrompt(app: AppContext, task: Task): Promise<string> {
  const { specs, requirements } = app.store.getState();
  const spec = specs.find((s) => s.id === task.specId);
  const reqs = requirements.filter((r) => task.requirementIds.includes(r.id));

  const codebaseSummary = await resolveCodebaseContext(app);
  const relevantFiles = await findRelevantFiles(
    [task.title, task.description, ...task.acceptanceCriteria].join(' '),
  );

  const parts: string[] = [];
  parts.push(`Implement the following engineering task in this workspace.\n`);
  parts.push(`## Codebase\n${codebaseSummary}`);
  if (relevantFiles.length) {
    parts.push(`\n## Possibly relevant existing files\n${relevantFiles.map((f) => `- ${f}`).join('\n')}\n(Matched by keyword, not verified — check before assuming relevance.)`);
  }
  parts.push(`\n## Task: ${task.title}\n${task.description}`);
  if (task.acceptanceCriteria.length) {
    parts.push(`\n## Acceptance criteria\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`);
  }
  if (spec) {
    parts.push(`\n## Parent spec: ${spec.title}\n(See .ariadne/${spec.filePath} for the full spec.)`);
  }
  if (reqs.length) {
    parts.push(`\n## Source requirements\n${reqs.map((r) => `- [${r.type}] ${r.title}: ${r.description}`).join('\n')}`);
  }
  parts.push(
    `\nMake the code changes needed to satisfy the acceptance criteria above. Follow the existing conventions in this codebase.`,
  );
  return parts.join('\n');
}

/**
 * "Run with [Backend]" — hands a task's description + acceptance criteria +
 * linked spec/requirement context to the selected AI backend, then links any
 * files the backend touched back into traceability.
 */
export async function runTaskWithBackend(app: AppContext, taskId?: string, backendId?: string): Promise<void> {
  const { tasks } = app.store.getState();
  let id = taskId;

  if (!id) {
    if (tasks.length === 0) {
      vscode.window.showWarningMessage('Ariadne: No tasks yet. Generate tasks from a spec first.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      tasks.map((t) => ({ label: t.title, description: t.status, id: t.id })),
      { title: 'Ariadne: Select a task to run' },
    );
    if (!picked) return;
    id = picked.id;
  }

  const task = tasks.find((t) => t.id === id);
  if (!task) {
    vscode.window.showWarningMessage('Ariadne: Task not found.');
    return;
  }

  const backend = backendId ? app.backends.getBackend(backendId) : app.backends.getActiveBackend();
  if (!backend) {
    vscode.window.showErrorMessage('Ariadne: No AI backend selected. Run "Ariadne: Select AI Backend".');
    return;
  }
  const available = await backend.isAvailable();
  if (!available) {
    vscode.window.showErrorMessage(`Ariadne: ${backend.name} is not available. ${backend.unavailableHint}`);
    return;
  }

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const prompt = await buildPrompt(app, task);

  app.output.show(true);
  app.output.appendLine(`\n=== Running "${task.title}" with ${backend.name} ===`);

  await app.store.updateTask(task.id, { status: 'in-progress', lastRunBackend: backend.id });
  await app.store.logActivity('task-run-started', `Started "${task.title}" with ${backend.name}`);

  const before = cwd ? await gitChangedFiles(cwd) : new Set<string>();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Ariadne: Running "${task.title}" with ${backend.name}…`, cancellable: true },
    async (_progress, token) => {
      try {
        const output = await backend.runTask(prompt, {
          cwd,
          token,
          onOutput: (chunk) => app.output.append(chunk),
        });
        app.output.appendLine(`\n--- ${backend.name} finished ---`);
        if (output && !output.includes('\n')) {
          // Short single-line outputs (e.g. from chat-only backends) are worth surfacing directly.
          app.output.appendLine(output);
        }

        const after = cwd ? await gitChangedFiles(cwd) : new Set<string>();
        const newFiles = [...after].filter((f) => !before.has(f));
        const files = Array.from(new Set([...task.files, ...newFiles]));

        await app.store.updateTask(task.id, { status: 'done', files, lastRunAt: new Date().toISOString() });
        await app.store.rebuildTraceability();
        await app.store.logActivity('task-run-finished', `Finished "${task.title}" (${files.length} file(s) touched)`);
        vscode.window.showInformationMessage(`Ariadne: "${task.title}" complete.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        app.output.appendLine(`\n--- ${backend.name} error: ${message} ---`);
        vscode.window.showErrorMessage(`Ariadne: Task run failed — ${message}`);
      }
    },
  );
}
