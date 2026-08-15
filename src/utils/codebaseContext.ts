import * as vscode from 'vscode';
import { AppContext } from '../appContext';

/**
 * Lightweight codebase awareness: no embeddings, no AST parsing — just a
 * filtered file listing, some counting, and keyword matching on paths. Good
 * enough to ground specs and task prompts in the actual project instead of
 * operating in a vacuum, without the cost/complexity of real code search.
 */

const EXCLUDE_GLOB =
  '**/{node_modules,.git,dist,out,build,.next,.nuxt,.venv,venv,__pycache__,target,.ariadne,.fde,coverage,vendor}/**';
const MAX_FILES_SCANNED = 800;
const DEFAULT_RELEVANT_LIMIT = 8;
const CACHE_TTL_MS = 30_000;

interface WorkspaceFile {
  relativePath: string;
  uri: vscode.Uri;
}

let cachedFiles: WorkspaceFile[] | undefined;
let cachedAt = 0;

async function listWorkspaceFiles(): Promise<WorkspaceFile[]> {
  const now = Date.now();
  if (cachedFiles && now - cachedAt < CACHE_TTL_MS) return cachedFiles;
  if (!vscode.workspace.workspaceFolders?.length) return [];
  const uris = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, MAX_FILES_SCANNED);
  cachedFiles = uris.map((uri) => ({ uri, relativePath: vscode.workspace.asRelativePath(uri, false) }));
  cachedAt = now;
  return cachedFiles;
}

const MANIFEST_MARKERS: Array<[string, string]> = [
  ['pyproject.toml', 'Python project (pyproject.toml)'],
  ['requirements.txt', 'Python project (requirements.txt)'],
  ['go.mod', 'Go module'],
  ['Cargo.toml', 'Rust crate'],
  ['pom.xml', 'Java/Maven project'],
  ['build.gradle', 'Java/Gradle project'],
  ['build.gradle.kts', 'Java/Gradle project'],
  ['Gemfile', 'Ruby project'],
  ['composer.json', 'PHP/Composer project'],
];

async function describeProject(files: WorkspaceFile[]): Promise<string | undefined> {
  const pkgFile = files.find((f) => f.relativePath === 'package.json');
  if (pkgFile) {
    try {
      const bytes = await vscode.workspace.fs.readFile(pkgFile.uri);
      const pkg = JSON.parse(new TextDecoder().decode(bytes)) as {
        name?: string;
        description?: string;
        dependencies?: Record<string, string>;
      };
      const deps = Object.keys(pkg.dependencies ?? {}).slice(0, 10);
      const parts = [pkg.name ? `"${pkg.name}"` : 'a Node.js/TypeScript project'];
      if (pkg.description) parts.push(pkg.description);
      if (deps.length) parts.push(`key dependencies: ${deps.join(', ')}`);
      return parts.join(' — ');
    } catch {
      return 'a Node.js/TypeScript project (package.json present but unreadable)';
    }
  }
  for (const [marker, label] of MANIFEST_MARKERS) {
    if (files.some((f) => f.relativePath === marker)) return label;
  }
  return undefined;
}

/** Cheap file count for ingestion metadata — reuses the same cached listing as summarizeWorkspace(). */
export async function countWorkspaceFiles(): Promise<number> {
  const files = await listWorkspaceFiles();
  return files.length;
}

/** A compact, prompt-sized description of the workspace: project type, structure, file mix. */
export async function summarizeWorkspace(): Promise<string> {
  const files = await listWorkspaceFiles();
  if (files.length === 0) return 'The workspace has no files yet (or none outside common build/dependency directories).';

  const byExt = new Map<string, number>();
  const byTopDir = new Map<string, number>();
  for (const f of files) {
    const dot = f.relativePath.lastIndexOf('.');
    const slash = f.relativePath.lastIndexOf('/');
    const ext = dot > slash ? f.relativePath.slice(dot) : '(no extension)';
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
    const topDir = f.relativePath.includes('/') ? f.relativePath.split('/')[0] : '(workspace root)';
    byTopDir.set(topDir, (byTopDir.get(topDir) ?? 0) + 1);
  }

  const topDirs = [...byTopDir.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([dir, count]) => `${dir}/ (${count})`)
    .join(', ');
  const topExts = [...byExt.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([ext, count]) => `${ext} (${count})`)
    .join(', ');

  const project = await describeProject(files);
  const cappedNote = files.length >= MAX_FILES_SCANNED ? '+' : '';

  return [
    project ? `Project: ${project}` : undefined,
    `${files.length}${cappedNote} files scanned (excluding node_modules/.git/dist/build/etc).`,
    `Top-level structure: ${topDirs}`,
    `Most common file types: ${topExts}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The single place every AI call site should go for "what's this codebase
 * like" — prefers the ingested, backend-authored understanding doc (see
 * contextEngine/codebaseIngestion.ts) and falls back to the cheap heuristic
 * summary when nothing has been ingested yet, so nothing breaks for users
 * who never run "Ariadne: Ingest Codebase".
 */
export async function resolveCodebaseContext(app: AppContext): Promise<string> {
  const ingested = await app.store.getCodebaseContextMarkdown();
  return ingested ?? summarizeWorkspace();
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are',
  'be', 'this', 'that', 'it', 'as', 'by', 'at', 'from', 'should', 'must', 'when', 'user',
  'system', 'will', 'can', 'into', 'their', 'they', 'not',
]);

function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Cheap relevance scoring: how many query keywords appear in each file's
 * path, weighted toward filename over directory. No content indexing.
 */
export async function findRelevantFiles(query: string, limit = DEFAULT_RELEVANT_LIMIT): Promise<string[]> {
  const words = tokenize(query);
  if (words.length === 0) return [];
  const files = await listWorkspaceFiles();

  const scored = files
    .map((f) => {
      const pathLower = f.relativePath.toLowerCase();
      const fileName = pathLower.slice(pathLower.lastIndexOf('/') + 1);
      let score = 0;
      for (const w of words) {
        if (fileName.includes(w)) score += 3;
        else if (pathLower.includes(w)) score += 1;
      }
      return { path: f.relativePath, score };
    })
    .filter((f) => f.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((f) => f.path);
}
