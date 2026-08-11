import * as vscode from 'vscode';
import {
  ActivityEntry,
  ActivityKind,
  FdeState,
  Requirement,
  Spec,
  Task,
  TraceabilityMap,
  newId,
  nowIso,
} from './types';

const ENC = new TextEncoder();
const DEC = new TextDecoder();

function emptyState(): FdeState {
  return {
    requirements: [],
    specs: [],
    tasks: [],
    traceability: { entries: [], updatedAt: nowIso() },
    activity: [],
  };
}

/**
 * Owns the .ariadne/ directory inside a workspace folder:
 *   .ariadne/requirements.json
 *   .ariadne/specs.json          (metadata for each Spec; markdown body lives in specs/*.md)
 *   .ariadne/specs/<id>.md
 *   .ariadne/tasks.json
 *   .ariadne/traceability.json
 *   .ariadne/activity.json
 *
 * Reads/writes go through vscode.workspace.fs so this also works against
 * virtual/remote workspaces. A FileSystemWatcher keeps the in-memory cache in
 * sync when files change outside the extension (multi-window, git checkout, etc).
 */
export class FdeDataStore implements vscode.Disposable {
  readonly root: vscode.Uri;
  readonly fdeDir: vscode.Uri;
  private state: FdeState = emptyState();
  private watcher: vscode.FileSystemWatcher | undefined;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private disposables: vscode.Disposable[] = [];

  constructor(workspaceFolder: vscode.WorkspaceFolder) {
    this.root = workspaceFolder.uri;
    this.fdeDir = vscode.Uri.joinPath(this.root, '.ariadne');
  }

  dispose(): void {
    this.watcher?.dispose();
    this._onDidChange.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  async initialize(): Promise<void> {
    await this.migrateLegacyDirectory();
    await this.ensureScaffold();
    await this.load();
    const pattern = new vscode.RelativePattern(this.fdeDir, '**/*');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const refresh = async () => {
      await this.load();
      this._onDidChange.fire();
    };
    this.disposables.push(
      this.watcher.onDidChange(refresh),
      this.watcher.onDidCreate(refresh),
      this.watcher.onDidDelete(refresh),
    );
  }

  /** One-time upgrade: earlier builds used .fde/ before the product was renamed to Ariadne. */
  private async migrateLegacyDirectory(): Promise<void> {
    if (await this.exists(this.fdeDir)) return;
    const legacyDir = vscode.Uri.joinPath(this.root, '.fde');
    if (!(await this.exists(legacyDir))) return;
    try {
      await vscode.workspace.fs.rename(legacyDir, this.fdeDir);
      vscode.window.showInformationMessage('Ariadne: Migrated your existing .fde/ data to .ariadne/.');
    } catch {
      // Best-effort — if the rename fails, ensureScaffold() below creates a fresh .ariadne/.
    }
  }

  private async ensureScaffold(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.fdeDir);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.fdeDir, 'specs'));
    const files: [string, unknown][] = [
      ['requirements.json', []],
      ['specs.json', []],
      ['tasks.json', []],
      ['traceability.json', { entries: [], updatedAt: nowIso() }],
      ['activity.json', []],
    ];
    for (const [name, defaultValue] of files) {
      const uri = vscode.Uri.joinPath(this.fdeDir, name);
      if (!(await this.exists(uri))) {
        await this.writeJson(uri, defaultValue);
      }
    }
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  private async readJson<T>(uri: vscode.Uri, fallback: T): Promise<T> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = DEC.decode(bytes);
      if (!text.trim()) return fallback;
      return JSON.parse(text) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJson(uri: vscode.Uri, value: unknown): Promise<void> {
    const text = JSON.stringify(value, null, 2) + '\n';
    await vscode.workspace.fs.writeFile(uri, ENC.encode(text));
  }

  private async load(): Promise<void> {
    const [requirements, specs, tasks, traceability, activity] = await Promise.all([
      this.readJson<Requirement[]>(vscode.Uri.joinPath(this.fdeDir, 'requirements.json'), []),
      this.readJson<Spec[]>(vscode.Uri.joinPath(this.fdeDir, 'specs.json'), []),
      this.readJson<Task[]>(vscode.Uri.joinPath(this.fdeDir, 'tasks.json'), []),
      this.readJson<TraceabilityMap>(vscode.Uri.joinPath(this.fdeDir, 'traceability.json'), {
        entries: [],
        updatedAt: nowIso(),
      }),
      this.readJson<ActivityEntry[]>(vscode.Uri.joinPath(this.fdeDir, 'activity.json'), []),
    ]);
    this.state = { requirements, specs, tasks, traceability, activity };
  }

  getState(): FdeState {
    return this.state;
  }

  // ---------- Requirements ----------

  async addRequirements(
    partials: Array<Omit<Requirement, 'id' | 'createdAt' | 'updatedAt' | 'status'> & { status?: Requirement['status'] }>,
  ): Promise<Requirement[]> {
    const created: Requirement[] = partials.map((p) => ({
      ...p,
      id: newId('req'),
      status: p.status ?? 'draft',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }));
    this.state.requirements.push(...created);
    await this.persistRequirements();
    for (const r of created) {
      await this.logActivity('requirement-added', `Added requirement "${r.title}"`);
    }
    this._onDidChange.fire();
    return created;
  }

  async updateRequirement(id: string, patch: Partial<Requirement>): Promise<Requirement | undefined> {
    const req = this.state.requirements.find((r) => r.id === id);
    if (!req) return undefined;
    Object.assign(req, patch, { updatedAt: nowIso() });
    await this.persistRequirements();
    this._onDidChange.fire();
    return req;
  }

  async deleteRequirement(id: string): Promise<boolean> {
    const before = this.state.requirements.length;
    this.state.requirements = this.state.requirements.filter((r) => r.id !== id);
    if (this.state.requirements.length === before) return false;
    await this.persistRequirements();
    await this.rebuildTraceability(); // also fires onDidChange
    return true;
  }

  private async persistRequirements(): Promise<void> {
    await this.writeJson(vscode.Uri.joinPath(this.fdeDir, 'requirements.json'), this.state.requirements);
  }

  // ---------- Specs ----------

  async addSpec(
    meta: Omit<Spec, 'id' | 'filePath' | 'createdAt' | 'updatedAt' | 'status'> & { status?: SpecStatusInput },
    markdown: string,
  ): Promise<Spec> {
    const id = newId('spec');
    const filePath = `specs/${id}.md`;
    const spec: Spec = {
      ...meta,
      id,
      filePath,
      status: meta.status ?? 'draft',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.fdeDir, filePath), ENC.encode(markdown));
    this.state.specs.push(spec);
    await this.persistSpecs();
    await this.logActivity('spec-generated', `Generated spec "${spec.title}"`);
    this._onDidChange.fire();
    return spec;
  }

  async updateSpec(id: string, patch: Partial<Spec>): Promise<Spec | undefined> {
    const spec = this.state.specs.find((s) => s.id === id);
    if (!spec) return undefined;
    Object.assign(spec, patch, { updatedAt: nowIso() });
    await this.persistSpecs();
    this._onDidChange.fire();
    return spec;
  }

  async getSpecMarkdown(spec: Spec): Promise<string> {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.fdeDir, spec.filePath));
      return DEC.decode(bytes);
    } catch {
      return '';
    }
  }

  specFileUri(spec: Spec): vscode.Uri {
    return vscode.Uri.joinPath(this.fdeDir, spec.filePath);
  }

  private async persistSpecs(): Promise<void> {
    await this.writeJson(vscode.Uri.joinPath(this.fdeDir, 'specs.json'), this.state.specs);
  }

  // ---------- Tasks ----------

  async addTasks(
    partials: Array<Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'files'> & { status?: Task['status']; files?: string[] }>,
  ): Promise<Task[]> {
    const created: Task[] = partials.map((p) => ({
      ...p,
      id: newId('task'),
      status: p.status ?? 'todo',
      files: p.files ?? [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }));
    this.state.tasks.push(...created);
    await this.persistTasks();
    await this.logActivity('tasks-generated', `Generated ${created.length} task(s)`);
    this._onDidChange.fire();
    return created;
  }

  async updateTask(id: string, patch: Partial<Task>): Promise<Task | undefined> {
    const task = this.state.tasks.find((t) => t.id === id);
    if (!task) return undefined;
    const prevStatus = task.status;
    Object.assign(task, patch, { updatedAt: nowIso() });
    await this.persistTasks();
    if (patch.status && patch.status !== prevStatus) {
      await this.logActivity('task-status-changed', `Task "${task.title}" -> ${task.status}`);
    }
    this._onDidChange.fire();
    return task;
  }

  private async persistTasks(): Promise<void> {
    await this.writeJson(vscode.Uri.joinPath(this.fdeDir, 'tasks.json'), this.state.tasks);
  }

  // ---------- Traceability ----------

  /**
   * Rebuilds traceability.json from the current requirements/specs/tasks graph.
   * Cheap enough to call after any structural change instead of diffing incrementally.
   */
  async rebuildTraceability(): Promise<TraceabilityMap> {
    const byReq = new Map<string, { specIds: Set<string>; taskIds: Set<string>; files: Set<string> }>();
    const ensure = (reqId: string) => {
      if (!byReq.has(reqId)) byReq.set(reqId, { specIds: new Set(), taskIds: new Set(), files: new Set() });
      return byReq.get(reqId)!;
    };
    for (const spec of this.state.specs) {
      for (const reqId of spec.requirementIds) {
        ensure(reqId).specIds.add(spec.id);
      }
    }
    for (const task of this.state.tasks) {
      for (const reqId of task.requirementIds) {
        const entry = ensure(reqId);
        entry.taskIds.add(task.id);
        for (const f of task.files) entry.files.add(f);
      }
      // A task under a spec inherits that spec's requirements too.
      if (task.specId) {
        const spec = this.state.specs.find((s) => s.id === task.specId);
        if (spec) {
          for (const reqId of spec.requirementIds) {
            const entry = ensure(reqId);
            entry.taskIds.add(task.id);
            for (const f of task.files) entry.files.add(f);
          }
        }
      }
    }
    const map: TraceabilityMap = {
      entries: [...byReq.entries()].map(([requirementId, v]) => ({
        requirementId,
        specIds: [...v.specIds],
        taskIds: [...v.taskIds],
        files: [...v.files],
      })),
      updatedAt: nowIso(),
    };
    this.state.traceability = map;
    await this.writeJson(vscode.Uri.joinPath(this.fdeDir, 'traceability.json'), map);
    this._onDidChange.fire();
    return map;
  }

  // ---------- Activity feed ----------

  async logActivity(kind: ActivityKind, message: string): Promise<void> {
    const entry: ActivityEntry = { id: newId('act'), kind, message, timestamp: nowIso() };
    this.state.activity.unshift(entry);
    this.state.activity = this.state.activity.slice(0, 200);
    await this.writeJson(vscode.Uri.joinPath(this.fdeDir, 'activity.json'), this.state.activity);
  }
}

type SpecStatusInput = Spec['status'];
