# Ariadne

An AI-powered workflow layer for forward-deployed engineering, for VS Code. Ariadne structures the FDE lifecycle — **requirements → specs → tasks → code → traceability** — and hands off actual code generation to whichever AI coding backend you already use (Claude Code, GitHub Copilot / VS Code's built-in Language Model API, or a local Ollama model).

Named for the thread that guided Theseus through the labyrinth: Ariadne is the thread connecting a messy business requirement to the code that satisfies it, so you can always trace your way back.

## Install & run (development)

```bash
npm install
npm run compile   # or: npm run watch
```

Then press **F5** in VS Code (or run the "Run Ariadne Extension" launch config) to open a new Extension Development Host window with Ariadne loaded. Open a folder in that window — Ariadne creates a `.ariadne/` directory in it the first time you use any command.

## What's where

Everything lives in the **Ariadne** activity bar icon:

- **Translator** (side panel) — a requirements **composer** at the top (Requirements tab), plus Specs / Tasks tabs and an **Assistant** chat tab (local, via Ollama). A persistent top strip shows the active AI backend and one-click access to the Dashboard.
- **Traceability** (side panel, below the translator) — a tree: Requirement → Spec → Task → Files. Click a file to open it.
- **Dashboard** (`Ariadne: Open Dashboard`) — a separate editor tab with a status-segmented progress ring, a Requirements→Specs→Tasks→Done stage stepper, coverage meters, business KPIs, and an activity timeline.

## Getting requirements in — the part that matters most

The Requirements tab opens on a **composer**, not a "click and hope the clipboard has the right thing in it" button:

- **Type or paste** directly into the box — no invisible clipboard state.
- **"Paste from clipboard"** pulls clipboard content into the box so you can see and edit it before anything happens.
- **Drag and drop** a `.txt`/`.md` file straight onto the composer (or use "Upload file").
- Click **Extract requirements** to run the Context Engine.

Extracted requirements land in a **review stage**, not straight into your project: each candidate is an editable card (title, type, description) with its own discard button. Nothing is added to `.ariadne/requirements.json` until you click **Add requirements**. This applies everywhere requirements get created, including `Ariadne: Decompose Clipboard into Requirements` from the Command Palette — it opens the panel, pre-fills the composer from your clipboard, and runs extraction into the same review stage.

Don't need AI for a one-off? Click **+ Add a requirement manually** for a plain form instead.

## The lifecycle

1. **Capture requirements** via the composer above (paste, type, or drop a file), review the staged results, and click **Add requirements**.
2. Review them in the list below, click **Mark verified** on the ones that are correct (or **delete** the ones that aren't — click the trash icon once to arm it, again within 3 seconds to confirm).
3. Check the requirements you want covered — a selection bar appears at the bottom — and click **Generate spec** (`/ariadne-spec`). This writes a Markdown spec under `.ariadne/specs/` with an explicit Acceptance Criteria section, grounded in a scan of your actual codebase (see below).
4. From the Specs tab, click **Generate tasks** (`/ariadne-tasks`) to turn the spec's acceptance criteria into discrete, independently completable tasks.
5. Optionally click **Check spec health** (`/ariadne-interrogate`) to have the Context Engine look for ambiguities, gaps, and conflicts before you start building.
6. Pick a backend from the pill at the top of the panel (shows a green dot when available) and click **Run with backend** on a task. Ariadne builds a prompt from the task, its acceptance criteria, its parent spec/requirements, *and* a scan of your codebase (project type, structure, and files that look relevant by keyword) — then hands it to the backend, and links whatever files changed back into traceability automatically (via `git status` before/after the run).

## Ariadne reads your codebase

Spec generation and task execution aren't run in a vacuum — `src/utils/codebaseContext.ts` scans the open workspace (via `vscode.workspace.findFiles`, skipping `node_modules`/`.git`/`dist`/`build`/etc.) and feeds two things into every Context Engine and task prompt:

- **A project summary**: detected project type (from `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, …), top-level directory structure, and the most common file types.
- **Keyword-matched relevant files**: for task execution, the task's title/description/acceptance criteria are matched against file paths to surface files that are plausibly related — flagged as a keyword match, not a verified one.

This is deliberately simple — path and manifest matching, no embeddings or AST parsing — but it means even backends with no filesystem access of their own (VS Code LM, Ollama) get real grounding instead of generic, framework-agnostic output. (Claude Code has its own filesystem tools and doesn't strictly need this, but the hint doesn't hurt.)

## AI backends

Backends are pluggable (`src/backends/`, implementing the `AIBackend` interface: `isAvailable()` + `runTask()`). Shipped adapters:

| Backend | How it works | Requires |
|---|---|---|
| **Claude Code** | Spawns the `claude` CLI in non-interactive print mode (`claude -p "…"`) in your workspace root. | The `claude` CLI on PATH — see [docs.claude.com/en/docs/claude-code](https://docs.claude.com/en/docs/claude-code). |
| **VS Code Language Model** | Uses the built-in `vscode.lm` API — whatever chat model you've consented to (e.g. via GitHub Copilot Chat). Text-only; no filesystem tool access. | GitHub Copilot Chat (or another chat participant), signed in. |
| **Ollama (Local)** | Calls a local Ollama server's `/api/chat` endpoint. Also powers the Assistant tab. | [Ollama](https://ollama.com) running locally with a model pulled (`ollama pull llama3.2`). |

Ariadne auto-detects which backends are available on startup and shows their status in the pill at the top of the Translator panel (or via `Ariadne: Select AI Backend`). Adding a new backend means adding one more class that implements `AIBackend` and registering it in `BackendManager`.

## Context Engine vs. task execution

Per the LLM strategy this extension was built around:

- **Context Engine** (`/ariadne-decompose`, `/ariadne-spec`, `/ariadne-interrogate`) calls the Anthropic API directly, billed to *your* Anthropic API key — set it with `Ariadne: Set Anthropic API Key` (stored in VS Code's secret storage) or the `ANTHROPIC_API_KEY` environment variable. Model defaults to `claude-opus-5`, configurable via `ariadne.contextEngine.model`.
- **Task execution** (`/ariadne-tasks` → "Run with [Backend]") runs on whichever backend you pick above, billed however that backend is normally billed.
- **Assistant** (Pro tab) runs entirely locally via Ollama — zero additional API cost.

## Data model

Everything is plain JSON + Markdown under `.ariadne/` in your workspace, so it's diffable and versionable alongside your code:

```
.ariadne/
  requirements.json     # Requirement[]
  specs.json             # Spec[] metadata
  specs/<id>.md           # spec body, Markdown
  tasks.json             # Task[]
  traceability.json       # requirement -> specs -> tasks -> files
  activity.json           # activity feed entries
  kpis.json               # optional — business KPIs shown on the Dashboard
```

`traceability.json` is rebuilt from the requirements/specs/tasks graph after every structural change rather than diffed incrementally, which keeps it simple and always internally consistent.

If a workspace has a `.fde/` directory from an earlier build of this extension (before the rename), Ariadne renames it to `.ariadne/` automatically the first time it activates — no data lost.

### Business KPIs on the Dashboard

The Dashboard's KPI section reads `.ariadne/kpis.json` if present:

```json
[
  { "label": "P95 latency", "value": 420, "unit": "ms" },
  { "label": "Model accuracy", "value": 94.2, "unit": "%" }
]
```

This is intentionally a plain file rather than a live integration in the MVP — wire it up to whatever metrics source your engagement already has.

## Commands

| Command | What it does |
|---|---|
| `Ariadne: Decompose Clipboard into Requirements` | `/ariadne-decompose` |
| `Ariadne: Generate Spec from Requirements` | `/ariadne-spec` |
| `Ariadne: Generate Tasks from Spec` | `/ariadne-tasks` |
| `Ariadne: Check Spec Health (Interrogate)` | `/ariadne-interrogate` |
| `Ariadne: Run Task with Backend` | Task execution |
| `Ariadne: Toggle Requirement Verified` | Draft ↔ Verified |
| `Ariadne: Select AI Backend` | Pick the active execution backend |
| `Ariadne: Set Anthropic API Key (Context Engine)` | Configure the Context Engine's own key |
| `Ariadne: Open Dashboard` | Progress / KPIs / activity feed |
| `Ariadne: Refresh` | Re-check backend availability, refresh views |

## Project layout

```
src/
  extension.ts            # activation: wires store, engine, backends, views, commands
  appContext.ts             # AppContext bundle passed into every command/view
  types.ts                  # Requirement / Spec / Task / Traceability data model
  dataStore.ts               # .ariadne/ read-write + FileSystemWatcher + legacy .fde/ migration
  backends/                 # AIBackend interface + adapters + BackendManager
  contextEngine/            # Anthropic-backed decompose/spec/interrogate + prompts
  commands/                  # one file per command, each independently callable/testable
  views/                     # webview side panel, traceability tree, spec health + dashboard panels
  utils/codebaseContext.ts  # workspace scanning: project summary + keyword file matching
```

Each command in `src/commands/` is a plain async function taking an `AppContext` plus explicit arguments — no hidden globals — so it can be called directly in a test with a fake store/engine/backends, not just through the VS Code command palette.

## Current scope & open questions

This is the Phase 1 + Phase 2 MVP described in the build brief: side panel, `/ariadne-decompose` / `/ariadne-spec` / `/ariadne-tasks`, pluggable backends, traceability tree, spec health, a locally-run Assistant, and a dashboard. Deliberately out of scope for this pass:

- **Bundling a small local model for zero-setup Assistant** — currently requires the user to install Ollama themselves.
- **Pro plan pricing** for Assistant + advanced features — not implemented; nothing here is gated.
- **Remote MCP servers for enterprise integrations** — not implemented; the backend interface is pluggable enough to add one.
- **Multi-root workspace support** — the MVP tracks a single `.ariadne/` in the first workspace folder.
- **Codebase awareness is path/manifest-based, not semantic** — no embeddings or code search; it's a fast, zero-dependency heuristic, not a substitute for a real code-search backend if this grows past MVP.
