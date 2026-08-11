import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { Requirement, RequirementType, Spec, SpecHealth, nowIso } from '../types';
import {
  DECOMPOSE_SYSTEM,
  INTERROGATE_SYSTEM,
  SPEC_SYSTEM,
  TASKS_SYSTEM,
  decomposeSchema,
  interrogateSchema,
  specSchema,
  tasksSchema,
} from './prompts';

const SECRET_KEY = 'ariadne.anthropicApiKey';

export interface DecomposedRequirement {
  title: string;
  description: string;
  type: RequirementType;
  tags?: string[];
}

export interface GeneratedSpec {
  title: string;
  markdown: string;
  acceptanceCriteria: string[];
}

export interface GeneratedTask {
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

/**
 * The "your cost" side of Ariadne's LLM strategy: calls Anthropic directly for
 * /ariadne-decompose, /ariadne-spec, and /ariadne-interrogate using Ariadne's own API key,
 * separate from whatever backend the user picks to execute tasks.
 */
export class ContextEngine {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private get model(): string {
    return vscode.workspace.getConfiguration('ariadne').get<string>('contextEngine.model', 'claude-opus-5');
  }

  async setApiKey(): Promise<void> {
    const key = await vscode.window.showInputBox({
      title: 'Ariadne: Anthropic API Key',
      prompt: 'Used for the Context Engine (/ariadne-decompose, /ariadne-spec, /ariadne-interrogate). Stored in VS Code secret storage.',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'sk-ant-...',
      validateInput: validateApiKeyInput,
    });
    if (!key) return;
    await this.context.secrets.store(SECRET_KEY, key.trim());
    vscode.window.showInformationMessage('Ariadne: Anthropic API key saved.');
  }

  private async resolveApiKey(): Promise<string> {
    const envKey = process.env.ANTHROPIC_API_KEY;
    if (envKey) {
      const badChar = findInvalidApiKeyChar(envKey);
      if (badChar) {
        throw new Error(
          `The ANTHROPIC_API_KEY environment variable contains an invalid character at position ${badChar.index + 1} ` +
            `(${describeChar(badChar)}). Fix it in your shell environment, or run "Ariadne: Set Anthropic API Key" ` +
            'to use a stored key instead (stored keys take priority-free precedence only when the env var is unset).',
        );
      }
      return envKey;
    }
    const stored = await this.context.secrets.get(SECRET_KEY);
    if (stored) return stored;
    const entered = await vscode.window.showInputBox({
      title: 'Ariadne: Anthropic API Key required',
      prompt: 'The Context Engine calls the Anthropic API directly. Enter your API key to continue (stored securely for next time).',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'sk-ant-...',
      validateInput: validateApiKeyInput,
    });
    if (!entered) {
      throw new Error(
        'No Anthropic API key configured. Run "Ariadne: Set Anthropic API Key" or set the ANTHROPIC_API_KEY environment variable.',
      );
    }
    const trimmed = entered.trim();
    await this.context.secrets.store(SECRET_KEY, trimmed);
    return trimmed;
  }

  private async client(): Promise<Anthropic> {
    const apiKey = await this.resolveApiKey();
    return new Anthropic({ apiKey });
  }

  private async createStructured<T>(
    system: string,
    userContent: string,
    schema: Record<string, unknown>,
    maxTokens = 16000,
  ): Promise<T> {
    const client = await this.client();
    try {
      const response = await client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        system,
        output_config: { format: { type: 'json_schema', schema } },
        messages: [{ role: 'user', content: userContent }],
      });
      if (response.stop_reason === 'refusal') {
        throw new Error('The Context Engine declined this request (safety policy). Try rephrasing the input.');
      }
      const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
      if (!textBlock) {
        throw new Error('The Context Engine returned no output.');
      }
      return JSON.parse(textBlock.text) as T;
    } catch (err) {
      throw this.friendlyError(err);
    }
  }

  private friendlyError(err: unknown): Error {
    if (err instanceof Anthropic.AuthenticationError) {
      return new Error(
        'Anthropic API key was rejected. Run "Ariadne: Set Anthropic API Key" to update it.',
      );
    }
    if (err instanceof Anthropic.APIError) {
      return new Error(`Context Engine request failed: ${err.message}`);
    }
    if (err instanceof TypeError && /ByteString/i.test(err.message)) {
      // The API key never reaches the network — the SDK's fetch layer rejects it while
      // building the x-api-key header, because it contains a character outside Latin1
      // (almost always a lookalike Unicode character from a corrupted copy-paste, e.g. a
      // Cyrillic "О" swapped in for a Latin "O"). Clear the bad stored key so the next
      // call re-prompts instead of silently reusing the same broken value forever.
      void this.context.secrets.delete(SECRET_KEY);
      return new Error(
        'Your Anthropic API key contains a character that isn\'t valid in an HTTP header — likely a lookalike ' +
          'character from a corrupted copy-paste (e.g. a Cyrillic "О" swapped in for a Latin "O"). The stored key ' +
          'has been cleared; run "Ariadne: Set Anthropic API Key" and type it manually rather than pasting.',
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  async decompose(rawText: string): Promise<DecomposedRequirement[]> {
    const trimmed = rawText.trim();
    if (!trimmed) return [];
    const result = await this.createStructured<{ requirements: DecomposedRequirement[] }>(
      DECOMPOSE_SYSTEM,
      `Extract engineering requirements from the following input:\n\n${trimmed}`,
      decomposeSchema,
    );
    return result.requirements;
  }

  async generateSpec(requirements: Requirement[], codebaseSummary?: string): Promise<GeneratedSpec> {
    const listed = requirements
      .map((r, i) => `${i + 1}. [${r.type}] ${r.title}\n   ${r.description}`)
      .join('\n');
    const codebaseBlock = codebaseSummary ? `\n\nThe spec will be implemented in this codebase:\n${codebaseSummary}` : '';
    return this.createStructured<GeneratedSpec>(
      SPEC_SYSTEM,
      `Write a spec covering these requirements:\n\n${listed}${codebaseBlock}`,
      specSchema,
    );
  }

  async generateTasks(spec: Spec, specMarkdown: string): Promise<GeneratedTask[]> {
    const criteria = spec.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n');
    const result = await this.createStructured<{ tasks: GeneratedTask[] }>(
      TASKS_SYSTEM,
      `Spec: ${spec.title}\n\n${specMarkdown}\n\nAcceptance criteria:\n${criteria}\n\nBreak this into discrete engineering tasks.`,
      tasksSchema,
    );
    return result.tasks;
  }

  async interrogate(spec: Spec, specMarkdown: string, requirements: Requirement[]): Promise<SpecHealth> {
    const reqText = requirements.map((r) => `- [${r.type}] ${r.title}: ${r.description}`).join('\n');
    const result = await this.createStructured<Omit<SpecHealth, 'checkedAt'>>(
      INTERROGATE_SYSTEM,
      `Spec: ${spec.title}\n\n${specMarkdown}\n\nSource requirements:\n${reqText || '(none linked)'}`,
      interrogateSchema,
    );
    return { ...result, checkedAt: nowIso() };
  }
}

interface InvalidChar {
  char: string;
  index: number;
  code: number;
}

/**
 * API keys are always plain ASCII. Anything outside printable ASCII (33-126,
 * i.e. excluding whitespace) is either a corrupted paste (a lookalike Unicode
 * character substituted for a similar-looking ASCII one — the classic cause
 * of a "ByteString" error from the HTTP layer) or an invisible character
 * (smart quotes, non-breaking spaces) that would otherwise fail as a mystifying
 * 401 instead. Catching it here, before it ever reaches an HTTP header, turns
 * both into an immediate, specific message instead of a cryptic runtime error.
 */
function findInvalidApiKeyChar(value: string): InvalidChar | undefined {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 33 || code > 126) {
      return { char: value[i], index: i, code };
    }
  }
  return undefined;
}

function describeChar(bad: InvalidChar): string {
  return `character "${bad.char}" (U+${bad.code.toString(16).toUpperCase().padStart(4, '0')})`;
}

function validateApiKeyInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const bad = findInvalidApiKeyChar(trimmed);
  if (!bad) return undefined;
  return `Contains an invalid ${describeChar(bad)} at position ${bad.index + 1} — this usually means a lookalike character was pasted in. Try retyping instead of pasting.`;
}
