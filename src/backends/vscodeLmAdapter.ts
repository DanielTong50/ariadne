import * as vscode from 'vscode';
import { AIBackend, AIBackendRunOptions } from './types';

/**
 * Uses the built-in VS Code Language Model API (vscode.lm), which routes to
 * whatever chat model the user has consented to (GitHub Copilot's Claude,
 * GPT, etc.) — no extra CLI or server required. This backend does not have
 * file-system tool access; it returns model output only, which is best used
 * for tasks where you paste the result yourself.
 */
export class VSCodeLMAdapter implements AIBackend {
  readonly id = 'vscode-lm';
  readonly name = 'VS Code Language Model';
  readonly unavailableHint =
    'No VS Code language models are available. Install GitHub Copilot Chat (or another chat participant) and sign in.';

  async isAvailable(): Promise<boolean> {
    try {
      const models = await vscode.lm.selectChatModels();
      return models.length > 0;
    } catch {
      return false;
    }
  }

  async runTask(prompt: string, options: AIBackendRunOptions = {}): Promise<string> {
    const models = await vscode.lm.selectChatModels();
    if (models.length === 0) {
      throw new Error(this.unavailableHint);
    }
    const model = models[0];
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const cts = new vscode.CancellationTokenSource();
    const sub = options.token?.onCancellationRequested(() => cts.cancel());
    try {
      const response = await model.sendRequest(messages, {}, cts.token);
      let full = '';
      for await (const chunk of response.text) {
        full += chunk;
        options.onOutput?.(chunk);
      }
      return full.trim();
    } catch (err) {
      if (err instanceof vscode.LanguageModelError) {
        throw new Error(`VS Code Language Model error: ${err.message} (${err.code})`);
      }
      throw err;
    } finally {
      sub?.dispose();
      cts.dispose();
    }
  }
}
