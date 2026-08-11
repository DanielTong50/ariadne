import * as vscode from 'vscode';
import { AIBackend, AIBackendRunOptions } from './types';

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Talks to a local Ollama server (http://localhost:11434 by default). Used as
 * a selectable task-execution backend and as the engine behind the
 * Assistant chat tab (Pro feature) — fully local, zero additional API cost.
 */
export class OllamaAdapter implements AIBackend {
  readonly id = 'ollama';
  readonly name = 'Ollama (Local)';
  readonly unavailableHint =
    'Ollama not found. Install it from https://ollama.com, run it, and pull a model, e.g. `ollama pull llama3.2`.';

  private get baseUrl(): string {
    return vscode.workspace.getConfiguration('ariadne').get<string>('ollama.url', 'http://localhost:11434');
  }

  private get model(): string {
    return vscode.workspace.getConfiguration('ariadne').get<string>('ollama.model', 'llama3.2');
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/api/tags`, { method: 'GET' }, 3000);
      return res.ok;
    } catch {
      return false;
    }
  }

  async runTask(prompt: string, options: AIBackendRunOptions = {}): Promise<string> {
    return this.chat([{ role: 'user', content: prompt }], options.token);
  }

  async chat(messages: OllamaChatMessage[], token?: vscode.CancellationToken): Promise<string> {
    const controller = new AbortController();
    const sub = token?.onCancellationRequested(() => controller.abort());
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages, stream: false }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Ollama request failed (${res.status}): ${text || res.statusText}`);
      }
      const data = (await res.json()) as { message?: { content?: string } };
      return data.message?.content?.trim() ?? '';
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Cancelled.');
      }
      if (err instanceof TypeError) {
        throw new Error(this.unavailableHint);
      }
      throw err;
    } finally {
      sub?.dispose();
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
