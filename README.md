# Ariadne

**Ariadne turns a raw business requirement into traceable, executable engineering work — inside VS Code.**

It structures the forward-deployed engineering lifecycle — **requirements → specs → tasks → code → traceability** — and hands off actual code generation to whichever AI coding backend you already use (Claude Code, GitHub Copilot / VS Code's built-in Language Model API, or a local Ollama model).

Named for the thread that guided Theseus through the labyrinth: Ariadne is the thread connecting a messy requirement to the code that satisfies it, so you can always trace your way back.

<table>
  <tr>
    <td width="50%"><img src="media/hero-maze.jpg" alt="A concrete maze viewed from above" width="100%"></td>
    <td width="50%"><img src="media/hero-restaurant.jpg" alt="A server pouring wine at a riverside restaurant table" width="100%"></td>
  </tr>
  <tr>
    <td align="center"><sub>Every requirement starts as a labyrinth.</sub></td>
    <td align="center"><sub>Ariadne gets it to the right table.</sub></td>
  </tr>
</table>

---

## Table of contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [The workflow](#the-workflow)
- [Interface](#interface)
- [Capturing requirements](#capturing-requirements)
- [AI backends](#ai-backends)
- [Context Engine vs. task execution](#context-engine-vs-task-execution)
- [Configuration](#configuration)
- [Commands](#commands)
- [Data model](#data-model)
- [How Ariadne reads your codebase](#how-ariadne-reads-your-codebase)
- [Project layout](#project-layout)
- [Development](#development)
- [Limitations](#limitations)
- [License](#license)

---

## Requirements

- VS Code 1.85 or later
- Node.js and npm (for building the extension from source)
- At least one AI backend available — see [AI backends](#ai-backends)
- An Anthropic API key for the Context Engine (requirement extraction, spec generation, spec health checks) — see [Context Engine vs. task execution](#context-engine-vs-task-execution)

## Quick start

```bash
npm install
npm run compile   # or: npm run watch
```

Press **F5** in VS Code (or run the "Run Ariadne Extension" launch configuration) to open a new Extension Development Host window with Ariadne loaded. Open a folder in that window — Ariadne creates a `.ariadne/` directory in it the first time you run any command.

## The workflow

1. **Capture requirements.** Paste, type, or drop a file into the composer, review the AI-extracted candidates, and click **Add requirements**.
2. **Verify.** Click **Mark verified** on requirements that are correct, or delete the ones that aren't (click the trash icon once to arm it, again within 3 seconds to confirm).
3. **Generate a spec.** Check the requirements you want covered and click **Generate spec** (`/ariadne-spec`). Ariadne writes a Markdown spec under `.ariadne/specs/` with an explicit Acceptance Criteria section, grounded in a scan of your actual codebase.
4. **Generate tasks.** From the Specs tab, click **Generate tasks** (`/ariadne-tasks`) to turn the spec's acceptance criteria into discrete, independently completable tasks.
5. **Check spec health (optional).** Click **Check spec health** (`/ariadne-interrogate`) to have the Context Engine flag ambiguities, gaps, and conflicts before you start building.
6. **Run tasks.** Pick a backend from the pill at the top of the panel (green dot = available) and click **Run with backend**. Ariadne builds a prompt from the task, its acceptance criteria, its parent spec/requirements, and a codebase scan — hands it to the backend — then links whatever files changed back into traceability automatically (via `git status` before/after the run).

## Interface

Everything lives in the **Ariadne** activity bar icon:

| Panel | Location | Purpose |
|---|---|---|
| **Translator** | Side panel | Requirements composer, Specs tab, Tasks tab, and an Assistant chat tab (local, via Ollama). A persistent top strip shows the active AI backend and one-click access to the Dashboard. |
| **Traceability** | Side panel, below Translator | A tree: Requirement → Spec → Task → Files. Click a file to open it. |
| **Dashboard** | `Ariadne: Open Dashboard` (separate editor tab) | A status-segmented progress ring, a Requirements → Specs → Tasks → Done stage stepper, coverage meters, business KPIs, and an activity timeline. |

## Capturing requirements

The Requirements tab opens on a composer, not a "click and hope the clipboard has the right thing in it" button:

- **Type or paste** directly into the box — no invisible clipboard state.
- **Paste from clipboard** pulls clipboard content into the box so you can see and edit it before anything happens.
- **Drag and drop** a `.txt`/`.md` file onto the composer, or use **Upload file**.
- Click **Extract requirements** to run the Context Engine.

Extracted requirements land in a review stage, not straight into your project: each candidate is an editable card (title, type, description) with its own discard button. Nothing is written to `.ariadne/requirements.json` until you click **Add requirements**. This applies everywhere requirements get created, including `Ariadne: Decompose Clipboard into Requirements` from the Command Palette — it opens the panel, pre-fills the composer from your clipboard, and runs extraction into the same review stage.

Don't need AI for a one-off? Click **+ Add a requirement manually** for a plain form instead.

## AI backends

Backends are pluggable (`src/backends/`), implementing a single `AIBackend` interface: `isAvailable()` + `runTask()`. Shipped adapters:

| Backend | How it works | Requires |
|---|---|---|
| **Claude Code** | Spawns the `claude` CLI in non-interactive print mode (`claude -p "…"`) in your workspace root. | The `claude` CLI on `PATH` — see [docs.claude.com/en/docs/claude-code](https://docs.claude.com/en/docs/claude-code). |
| **VS Code Language Model** | Uses the built-in `vscode.lm` API — whatever chat model you've consented to (e.g. via GitHub Copilot Chat). Text-only; no filesystem tool access. | GitHub Copilot Chat (or another chat participant), signed in. |
| **Ollama (Local)** | Calls a local Ollama server's `/api/chat` endpoint. Also powers the Assistant tab. | [Ollama](https://ollama.com) running locally with a model pulled (`ollama pull llama3.2`). |

Ariadne auto-detects which backends are available on startup and shows their status in the pill at the top of the Translator panel, or via `Ariadne: Select AI Backend`. Adding a new backend means implementing `AIBackend` and registering the adapter in `BackendManager`.

## Context Engine vs. task execution

Ariadne makes two distinct kinds of AI calls, and it's worth knowing which is which:

- **Context Engine** (`/ariadne-decompose`, `/ariadne-spec`, `/ariadne-interrogate`) calls the Anthropic API directly, using your own Anthropic API key. Set it with `Ariadne: Set Anthropic API Key` (stored in VS Code's secret storage) or the `ANTHROPIC_API_KEY` environment variable. Model defaults to `claude-opus-5`, configurable via `ariadne.contextEngine.model`.
- **Task execution** (`/ariadne-tasks` → "Run with [Backend]") runs on whichever backend you select, using that backend's own credentials/session.
- **Assistant chat** runs entirely locally via Ollama, with no API key required.

## Configuration

Set these under **Settings → Extensions → Ariadne**, or directly in `settings.json`:

| Setting | Default | Description |
|---|---|---|
| `ariadne.contextEngine.model` | `claude-opus-5` | Anthropic model used for the Context Engine (`/ariadne-decompose`, `/ariadne-spec`, `/ariadne-interrogate`). |
| `ariadne.preferredBackend` | `claude-code` | Default backend used for "Run with [Backend]" task execution. One of `claude-code`, `vscode-lm`, `ollama`. |
| `ariadne.ollama.url` | `http://localhost:11434` | Base URL for the local Ollama server. |
| `ariadne.ollama.model` | `llama3.2` | Ollama model used by the Assistant chat. |
| `ariadne.claudeCode.command` | `claude` | Command used to invoke the Claude Code CLI. |

## Commands

All commands are available from the Command Palette under the `Ariadne:` prefix.

| Command | Effect |
|---|---|
| `Ariadne: Decompose Clipboard into Requirements` | Runs `/ariadne-decompose` on clipboard content |
| `Ariadne: Generate Spec from Requirements` | Runs `/ariadne-spec` |
| `Ariadne: Generate Tasks from Spec` | Runs `/ariadne-tasks` |
| `Ariadne: Check Spec Health (Interrogate)` | Runs `/ariadne-interrogate` |
| `Ariadne: Run Task with Backend` | Executes a task against the active backend |
| `Ariadne: Toggle Requirement Verified` | Toggles a requirement between Draft and Verified |
| `Ariadne: Select AI Backend` | Chooses the active execution backend |
| `Ariadne: Set Anthropic API Key (Context Engine)` | Configures the Context Engine's own key |
| `Ariadne: Open Dashboard` | Opens the progress / KPIs / activity feed view |
| `Ariadne: Refresh` | Re-checks backend availability and refreshes views |

## Data model

Everything is plain JSON and Markdown under `.ariadne/` in your workspace, so it's diffable and versionable alongside your code:

```
.ariadne/
  requirements.json   Requirement[]
  specs.json           Spec[] metadata
  specs/<id>.md         Spec body, Markdown
  tasks.json           Task[]
  traceability.json     Requirement -> Specs -> Tasks -> Files
  activity.json         Activity feed entries
  kpis.json             Optional — business KPIs shown on the Dashboard
```

`traceability.json` is rebuilt from the requirements/specs/tasks graph after every structural change rather than diffed incrementally, keeping it simple and always internally consistent.

If a workspace has a `.fde/` directory from an earlier build of this extension, Ariadne renames it to `.ariadne/` automatically the first time it activates — no data lost.

### Business KPIs on the Dashboard

The Dashboard's KPI section reads `.ariadne/kpis.json` if present:

```json
[
  { "label": "P95 latency", "value": 420, "unit": "ms" },
  { "label": "Model accuracy", "value": 94.2, "unit": "%" }
]
```

This is a plain, hand-edited file rather than a live integration — wire it up to whatever metrics source your engagement already has.

## How Ariadne reads your codebase

Spec generation and task execution aren't run in a vacuum. `src/utils/codebaseContext.ts` scans the open workspace (via `vscode.workspace.findFiles`, skipping `node_modules`/`.git`/`dist`/`build`/etc.) and feeds two things into every Context Engine and task prompt:

- **A project summary** — detected project type (from `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, …), top-level directory structure, and the most common file types.
- **Keyword-matched relevant files** — for task execution, the task's title/description/acceptance criteria are matched against file paths to surface files that are plausibly related, flagged as a keyword match, not a verified one.

This is deliberately simple — path and manifest matching, no embeddings or AST parsing — but it means even backends with no filesystem access of their own (VS Code LM, Ollama) get real grounding instead of generic, framework-agnostic output. Claude Code has its own filesystem tools and doesn't strictly need this, but the hint doesn't hurt.

## Project layout

```
src/
  extension.ts           Activation: wires store, engine, backends, views, commands
  appContext.ts           AppContext bundle passed into every command/view
  types.ts                 Requirement / Spec / Task / Traceability data model
  dataStore.ts              .ariadne/ read-write + FileSystemWatcher + legacy .fde/ migration
  backends/                 AIBackend interface + adapters + BackendManager
  contextEngine/            Anthropic-backed decompose/spec/interrogate + prompts
  commands/                 One file per command, each independently callable/testable
  views/                    Webview side panel, traceability tree, spec health + dashboard panels
  utils/codebaseContext.ts  Workspace scanning: project summary + keyword file matching
```

Each command in `src/commands/` is a plain async function taking an `AppContext` plus explicit arguments — no hidden globals — so it can be called directly in a test with a fake store/engine/backends, not just through the VS Code Command Palette.

## Development

```bash
npm install         # install dependencies
npm run compile      # one-off build (esbuild -> dist/extension.js)
npm run watch         # rebuild on save
npm run typecheck      # tsc --noEmit
npm run package          # production build for packaging
```

Press **F5** to launch the Extension Development Host and iterate against a real workspace.

## Limitations

Current scope is intentionally focused. Not implemented yet:

- **Bundled local model for zero-setup Assistant** — currently requires installing Ollama yourself.
- **Remote MCP servers for enterprise integrations** — the backend interface is pluggable enough to add one.
- **Multi-root workspace support** — a single `.ariadne/` directory is tracked, in the first workspace folder.
- **Semantic codebase awareness** — file matching is path/manifest-based, not embeddings or code search; fast and dependency-free, but not a substitute for a real code-search backend at scale.

## License

MIT — see [LICENSE](LICENSE).
