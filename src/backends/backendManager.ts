import * as vscode from 'vscode';
import { AIBackend } from './types';
import { ClaudeCodeAdapter } from './claudeCodeAdapter';
import { VSCodeLMAdapter } from './vscodeLmAdapter';
import { OllamaAdapter } from './ollamaAdapter';

export interface BackendStatus {
  backend: AIBackend;
  available: boolean;
}

/**
 * Registers every AIBackend, auto-detects availability on startup (and on
 * demand), and tracks which one is "active" for Run with [Backend]. Adapters
 * are pluggable — add a new one here and it shows up in the selector.
 */
export class BackendManager implements vscode.Disposable {
  readonly backends: AIBackend[];
  readonly ollama: OllamaAdapter;
  private statusMap = new Map<string, boolean>();
  private readonly _onDidChangeStatus = new vscode.EventEmitter<void>();
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.ollama = new OllamaAdapter();
    this.backends = [new ClaudeCodeAdapter(), new VSCodeLMAdapter(), this.ollama];
  }

  dispose(): void {
    this._onDidChangeStatus.dispose();
  }

  async refreshAvailability(): Promise<void> {
    await Promise.all(
      this.backends.map(async (b) => {
        const available = await b.isAvailable().catch(() => false);
        this.statusMap.set(b.id, available);
      }),
    );
    this._onDidChangeStatus.fire();
  }

  getStatuses(): BackendStatus[] {
    return this.backends.map((backend) => ({ backend, available: this.statusMap.get(backend.id) ?? false }));
  }

  isAvailable(id: string): boolean {
    return this.statusMap.get(id) ?? false;
  }

  getBackend(id: string): AIBackend | undefined {
    return this.backends.find((b) => b.id === id);
  }

  get activeBackendId(): string {
    const stored = this.context.workspaceState.get<string>('ariadne.activeBackend');
    const preferred = vscode.workspace.getConfiguration('ariadne').get<string>('preferredBackend', 'claude-code');
    return stored ?? preferred;
  }

  async setActiveBackendId(id: string): Promise<void> {
    await this.context.workspaceState.update('ariadne.activeBackend', id);
    this._onDidChangeStatus.fire();
  }

  getActiveBackend(): AIBackend | undefined {
    return this.getBackend(this.activeBackendId) ?? this.backends[0];
  }
}
