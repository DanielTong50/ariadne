import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { AIBackend, AIBackendRunOptions } from './types';

/**
 * Spawns the Claude Code CLI in non-interactive "print" mode:
 *   claude -p "<prompt>" --output-format text
 * Requires the `claude` CLI to be installed and on PATH (or configured via
 * ariadne.claudeCode.command). See https://docs.claude.com/en/docs/claude-code
 */
export class ClaudeCodeAdapter implements AIBackend {
  readonly id = 'claude-code';
  readonly name = 'Claude Code';
  readonly unavailableHint =
    'Claude Code CLI not found. Install it from https://docs.claude.com/en/docs/claude-code and make sure `claude` is on your PATH.';

  private get command(): string {
    return vscode.workspace.getConfiguration('ariadne').get<string>('claudeCode.command', 'claude');
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.exec(['--version'], { timeoutMs: 4000 });
      return true;
    } catch {
      return false;
    }
  }

  async runTask(prompt: string, options: AIBackendRunOptions = {}): Promise<string> {
    const args = ['-p', prompt, '--output-format', 'text'];
    return this.exec(args, {
      cwd: options.cwd,
      onOutput: options.onOutput,
      token: options.token,
    });
  }

  private exec(
    args: string[],
    opts: { cwd?: string; timeoutMs?: number; onOutput?: (chunk: string) => void; token?: vscode.CancellationToken },
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, {
        cwd: opts.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        shell: process.platform === 'win32',
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = opts.timeoutMs
        ? setTimeout(() => {
            if (!settled) {
              settled = true;
              child.kill();
              reject(new Error('Claude Code CLI timed out.'));
            }
          }, opts.timeoutMs)
        : undefined;

      const cancelSub = opts.token?.onCancellationRequested(() => {
        if (!settled) {
          settled = true;
          child.kill();
          reject(new Error('Cancelled.'));
        }
      });

      child.stdout?.on('data', (d: Buffer) => {
        const text = d.toString();
        stdout += text;
        opts.onOutput?.(text);
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        cancelSub?.dispose();
        if (err.code === 'ENOENT') {
          reject(new Error(this.unavailableHint));
        } else {
          reject(err);
        }
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        cancelSub?.dispose();
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr.trim() || `Claude Code CLI exited with code ${code}.`));
        }
      });
    });
  }
}
