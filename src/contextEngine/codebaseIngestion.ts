import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { AIBackend } from '../backends/types';
import { countWorkspaceFiles, summarizeWorkspace } from '../utils/codebaseContext';

const execAsync = promisify(exec);

/**
 * Root-level files worth inlining verbatim into the ingestion prompt — the
 * same manifest names codebaseContext.ts's project-type detection already
 * recognizes, plus a README. Every backend gets these regardless of whether
 * it can explore the filesystem itself.
 */
const ANCHOR_FILE_NAMES = [
  'README.md',
  'readme.md',
  'README',
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
];
const ANCHOR_BYTE_BUDGET = 24_000;

interface AnchorFile {
  name: string;
  content: string;
}

async function gatherAnchorFiles(): Promise<AnchorFile[]> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return [];
  const files: AnchorFile[] = [];
  let budget = ANCHOR_BYTE_BUDGET;
  for (const name of ANCHOR_FILE_NAMES) {
    if (budget <= 0) break;
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, name));
      let content = new TextDecoder().decode(bytes);
      if (content.length > budget) content = `${content.slice(0, budget)}\n...(truncated)`;
      budget -= content.length;
      files.push({ name, content });
    } catch {
      // not present at the root — skip
    }
  }
  return files;
}

function buildIngestionPrompt(summary: string, anchors: AnchorFile[], isAgentic: boolean): string {
  const anchorBlock = anchors.length
    ? anchors.map((a) => `### ${a.name}\n\`\`\`\n${a.content}\n\`\`\``).join('\n\n')
    : '(No README or manifest file found at the workspace root.)';

  const explorationNote = isAgentic
    ? `You are running with real access to this repository's filesystem (your working directory is the repo root). Use your own file-reading and search tools to explore further wherever the excerpts below aren't enough — read actual source files rather than guessing.`
    : `You only have the excerpts below to go on — do your best from them, and say when you're inferring rather than certain.`;

  return `You are building a persistent "codebase understanding" document for an engineering team, so that future AI-assisted work (writing specs, breaking down tasks, implementing code) is grounded in how this codebase actually works instead of generic assumptions.

${explorationNote}

## Heuristic project summary
${summary}

## Root file excerpts
${anchorBlock}

Produce a Markdown document with exactly these sections, in this order:
## Overview
What this project is and does, in a few sentences.
## Architecture
The main modules/directories and how they relate — what lives where.
## Tech Stack
Languages, frameworks, key libraries, and why they matter here.
## Conventions
Naming, code style, testing approach, and other patterns a contributor should follow.
## Key Entry Points
The files/functions where execution starts, or where a new contributor should look first.
## Gotchas & Constraints
Anything non-obvious that would trip up someone unfamiliar with the codebase — subtle invariants, workarounds, things that look like bugs but aren't.

Be concrete and specific to this codebase — reference real file and directory names. Do not pad this with generic software-engineering advice that would apply to any project.`;
}

async function getGitHead(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync('git rev-parse --short HEAD', { cwd, timeout: 5000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface IngestionResult {
  markdown: string;
  fileCount: number;
  gitCommit?: string;
}

/**
 * Runs codebase ingestion on whichever AIBackend is passed in (Claude Code,
 * VS Code LM, or Ollama) — the same runTask() interface already used to
 * execute engineering tasks. Claude Code specifically gets an extra nudge to
 * explore the repo with its own tools, since it (unlike the other two
 * single-shot completion backends) actually runs agentically in `cwd`.
 */
export async function ingestCodebase(
  backend: AIBackend,
  cwd: string | undefined,
  token: vscode.CancellationToken | undefined,
  onOutput: ((chunk: string) => void) | undefined,
): Promise<IngestionResult> {
  const [summary, anchors, fileCount, gitCommit] = await Promise.all([
    summarizeWorkspace(),
    gatherAnchorFiles(),
    countWorkspaceFiles(),
    cwd ? getGitHead(cwd) : Promise.resolve(undefined),
  ]);
  const prompt = buildIngestionPrompt(summary, anchors, backend.id === 'claude-code');
  const markdown = await backend.runTask(prompt, { cwd, token, onOutput });
  return { markdown: markdown.trim(), fileCount, gitCommit };
}
