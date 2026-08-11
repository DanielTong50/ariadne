/**
 * Pluggable interface every AI coding backend implements. Task Execution runs
 * on the user's chosen backend and is billed to them (Claude Code, Cursor,
 * Copilot via VS Code LM, or a local model via Ollama) — distinct from the
 * Context Engine, which Ariadne calls directly for /ariadne-decompose, /ariadne-spec,
 * and /ariadne-interrogate.
 */
export interface AIBackendRunOptions {
  /** Working directory the backend should operate in (defaults to the workspace root). */
  cwd?: string;
  /** Called with incremental output as the backend produces it, when supported. */
  onOutput?: (chunk: string) => void;
  token?: import('vscode').CancellationToken;
}

export interface AIBackend {
  readonly id: string;
  readonly name: string;
  /** Human-readable hint shown when the backend is unavailable, e.g. install instructions. */
  readonly unavailableHint: string;
  isAvailable(): Promise<boolean>;
  runTask(prompt: string, options?: AIBackendRunOptions): Promise<string>;
}
