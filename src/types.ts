export type ModelRef = string; // "provider/model[#variant]"

export interface TaskSpec {
  id: string;
  /** Short human-readable summary. Must be written in simplified technical English. */
  title: string;
  prompt: string;
  dependsOn: string[];
  /** Optional model used for the first attempt; later attempts escalate. */
  model?: ModelRef;
}

export interface PlanInput {
  tasks: TaskSpec[];
}

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "passed"
  | "failed"
  | "blocked";

export interface Attempt {
  model: ModelRef;
  startedAt: number;
  finishedAt?: number;
  outcome?: "passed" | "failed";
  costUSD?: number;
  tokens?: { input: number; output: number };
  sessionID?: string;
}

export interface TaskState extends TaskSpec {
  status: TaskStatus;
  attempts: Attempt[];
}

export type RunStatus =
  | "awaiting_approval"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunEvent {
  at: number;
  kind: string;
  detail: string;
}

export interface RunState extends PlanInput {
  id: string;
  goal: string;
  status: RunStatus;
  tasks: TaskState[];
  budgetUSD: number;
  costUSD: number;
  /** Integration branch that receives accepted task work. */
  integrationBranch: string;
  /** Agent used for engineer sessions. */
  engineerAgent: string;
  /** Escalation chain used by tasks without a per-task model. */
  modelChain: ModelRef[];
  maxAttempts: number;
  maxParallel: number;
  /** taskID -> created worktree directory. */
  worktrees: Record<string, string>;
  events: RunEvent[];
  createdAt: number;
  updatedAt: number;
}

export type EngineerRole = "engineer" | "validator";
