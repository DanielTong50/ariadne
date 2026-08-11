import * as vscode from 'vscode';
import { AppContext } from '../appContext';

type TraceNode =
  | { kind: 'requirement'; requirementId: string }
  | { kind: 'spec'; specId: string; requirementId: string }
  | { kind: 'task'; taskId: string; requirementId: string }
  | { kind: 'file'; path: string };

/** Requirement -> Spec -> Task -> Files, driven by .ariadne/traceability.json. */
export class TraceabilityTreeProvider implements vscode.TreeDataProvider<TraceNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly app: AppContext) {
    app.store.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: TraceNode): vscode.TreeItem {
    const { requirements, specs, tasks } = this.app.store.getState();

    if (node.kind === 'requirement') {
      const req = requirements.find((r) => r.id === node.requirementId);
      const item = new vscode.TreeItem(req?.title ?? node.requirementId, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = req?.status;
      item.iconPath = new vscode.ThemeIcon(req?.status === 'verified' ? 'pass' : 'circle-outline');
      item.contextValue = 'fdeRequirement';
      return item;
    }
    if (node.kind === 'spec') {
      const spec = specs.find((s) => s.id === node.specId);
      const item = new vscode.TreeItem(spec?.title ?? node.specId, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = spec?.status;
      item.iconPath = new vscode.ThemeIcon('file-text');
      item.contextValue = 'fdeSpec';
      if (spec) {
        item.command = {
          command: 'vscode.open',
          title: 'Open Spec',
          arguments: [this.app.store.specFileUri(spec)],
        };
      }
      return item;
    }
    if (node.kind === 'task') {
      const task = tasks.find((t) => t.id === node.taskId);
      const collapsible = task && task.files.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
      const item = new vscode.TreeItem(task?.title ?? node.taskId, collapsible);
      item.description = task?.status;
      item.iconPath = new vscode.ThemeIcon(
        task?.status === 'done' ? 'check' : task?.status === 'in-progress' ? 'sync' : 'circle-large-outline',
      );
      item.contextValue = 'fdeTask';
      return item;
    }
    // file
    const item = new vscode.TreeItem(node.path, vscode.TreeItemCollapsibleState.None);
    item.iconPath = vscode.ThemeIcon.File;
    item.resourceUri = this.resolveFileUri(node.path);
    item.command = {
      command: 'ariadne.openFile',
      title: 'Open File',
      arguments: [node.path],
    };
    item.contextValue = 'fdeFile';
    return item;
  }

  getChildren(node?: TraceNode): TraceNode[] {
    const { traceability, tasks } = this.app.store.getState();

    if (!node) {
      return traceability.entries.map((e) => ({ kind: 'requirement', requirementId: e.requirementId }));
    }

    if (node.kind === 'requirement') {
      const entry = traceability.entries.find((e) => e.requirementId === node.requirementId);
      if (!entry) return [];
      const specNodes: TraceNode[] = entry.specIds.map((specId) => ({ kind: 'spec', specId, requirementId: node.requirementId }));
      const nestedTaskIds = new Set(
        entry.taskIds.filter((taskId) => {
          const task = tasks.find((t) => t.id === taskId);
          return task?.specId && entry.specIds.includes(task.specId);
        }),
      );
      const looseTaskNodes: TraceNode[] = entry.taskIds
        .filter((taskId) => !nestedTaskIds.has(taskId))
        .map((taskId) => ({ kind: 'task', taskId, requirementId: node.requirementId }));
      return [...specNodes, ...looseTaskNodes];
    }

    if (node.kind === 'spec') {
      const entry = traceability.entries.find((e) => e.requirementId === node.requirementId);
      if (!entry) return [];
      return entry.taskIds
        .filter((taskId) => tasks.find((t) => t.id === taskId)?.specId === node.specId)
        .map((taskId) => ({ kind: 'task', taskId, requirementId: node.requirementId }));
    }

    if (node.kind === 'task') {
      const task = tasks.find((t) => t.id === node.taskId);
      return (task?.files ?? []).map((path) => ({ kind: 'file', path }));
    }

    return [];
  }

  private resolveFileUri(path: string): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;
    try {
      return vscode.Uri.joinPath(folder.uri, path);
    } catch {
      return undefined;
    }
  }
}
