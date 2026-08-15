// Core data model for the FDE lifecycle: requirements -> specs -> tasks -> traceability.
// Everything here is persisted under the workspace's .ariadne/ directory.

export type RequirementStatus = 'draft' | 'verified';
export type RequirementType = 'functional' | 'non-functional' | 'business' | 'technical';

export interface Requirement {
  id: string;
  title: string;
  description: string;
  type: RequirementType;
  status: RequirementStatus;
  source?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export type SpecStatus = 'draft' | 'reviewed' | 'approved';

export interface SpecHealth {
  ambiguities: string[];
  gaps: string[];
  conflicts: string[];
  checkedAt: string;
}

export interface Spec {
  id: string;
  title: string;
  requirementIds: string[];
  filePath: string; // relative to .ariadne/, e.g. specs/spec-xxxx.md
  acceptanceCriteria: string[];
  status: SpecStatus;
  health?: SpecHealth;
  createdAt: string;
  updatedAt: string;
}

export type TaskStatus = 'todo' | 'in-progress' | 'done';

export interface Task {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  specId?: string;
  requirementIds: string[];
  status: TaskStatus;
  files: string[]; // workspace-relative file paths touched/linked to this task
  lastRunBackend?: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TraceabilityEntry {
  requirementId: string;
  specIds: string[];
  taskIds: string[];
  files: string[];
}

export interface TraceabilityMap {
  entries: TraceabilityEntry[];
  updatedAt: string;
}

export interface CodebaseContextMeta {
  ingestedAt: string;
  backendId: string;
  backendName: string;
  gitCommit?: string;
  fileCount: number;
  contentHash: string; // sha256 of the .md body at write time, to detect local edits before overwriting
}

export type ActivityKind =
  | 'requirement-added'
  | 'requirement-verified'
  | 'spec-generated'
  | 'spec-health-checked'
  | 'tasks-generated'
  | 'task-run-started'
  | 'task-run-finished'
  | 'task-status-changed'
  | 'codebase-ingested';

export interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  message: string;
  timestamp: string;
}

export interface FdeState {
  requirements: Requirement[];
  specs: Spec[];
  tasks: Task[];
  traceability: TraceabilityMap;
  activity: ActivityEntry[];
  codebaseContext?: CodebaseContextMeta;
}

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const time = Date.now().toString(36);
  return `${prefix}-${time}${rand}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
