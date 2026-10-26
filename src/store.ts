import { toTaskStates } from "./plan.ts";
import { MemoryStorage, type StorageLike } from "./storage/memory.ts";
import type { PlanInput, RunOwner, RunState } from "./types.ts";

const KEY_PREFIX = "orchestrator:run:";
const KEY_RE = /^orchestrator:run:(.+)$/;

export { MemoryStorage, type StorageLike };

/** Small difference preserved by OpenCode server storage; serialized state must stay inside it. */
const MAX_STATE_BYTES = 512 * 1024;

function keyFor(id: string) {
  return `${KEY_PREFIX}${id}`;
}

function serialize(run: RunState) {
  const value = JSON.stringify(run);
  if (value.length > MAX_STATE_BYTES) {
    throw new Error(`run ${run.id} state exceeds ${MAX_STATE_BYTES} bytes`);
  }
  return value;
}

function deserialize(value: unknown): RunState | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as RunState | undefined;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as RunState).id === "string" &&
      Array.isArray((parsed as RunState).tasks)
    ) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export interface NewRunInput extends PlanInput {
  goal: string;
  budgetUSD: number;
  integrationBranch: string;
  engineerAgent?: string;
  modelChain?: string[];
  modelPolicy?: import("./model-policy.ts").ModelPolicyEntry[];
  maxAttempts?: number;
  maxParallel?: number;
  owner?: RunOwner;
}

let counter = 0;
const createdMs = () => Date.now();

export async function createRun(storage: StorageLike, input: NewRunInput): Promise<RunState> {
  if (typeof input.goal !== "string" || input.goal.trim().length === 0) {
    throw new Error("empty goal");
  }
  if (typeof input.budgetUSD !== "number" || !(input.budgetUSD > 0)) {
    throw new Error("budgetUSD must be a positive number");
  }
  if (typeof input.integrationBranch !== "string" || input.integrationBranch.length === 0) {
    throw new Error("integrationBranch must be a non-empty string");
  }

  const now = createdMs();
  const id = `run-${now}-${++counter}`;
  const run: RunState = {
    id,
    goal: input.goal.trim(),
    status: "awaiting_approval",
    owner: input.owner,
    tasks: toTaskStates(input),
    budgetUSD: input.budgetUSD,
    costUSD: 0,
    integrationBranch: input.integrationBranch,
    engineerAgent: input.engineerAgent ?? "engineer",
    modelChain: input.modelChain && input.modelChain.length > 0 ? input.modelChain : ["opencode/beam-free"],
    modelPolicy: input.modelPolicy,
    maxAttempts: input.maxAttempts && input.maxAttempts > 0 ? Math.min(input.maxAttempts, 10) : 3,
    maxParallel: input.maxParallel && input.maxParallel > 0 ? Math.min(input.maxParallel, 8) : 2,
    worktrees: {},
    events: [{ at: now, kind: "created", detail: `goal: ${input.goal.trim()}` }],
    createdAt: now,
    updatedAt: now,
  };
  await storage.set(keyFor(id), serialize(run));
  return run;
}

export async function getRun(storage: StorageLike, id: string): Promise<RunState | undefined> {
  return deserialize(await storage.get(keyFor(id)));
}

export async function listRuns(storage: StorageLike): Promise<RunState[]> {
  const entries = await storage.scan({ prefix: KEY_PREFIX });
  return entries
    .map((entry) => deserialize(entry.value))
    .filter((run): run is RunState => run !== undefined)
    .sort((a, b) => (b.createdAt - a.createdAt) || (seqOf(b.id) - seqOf(a.id)));
}

function seqOf(id: string) {
  const suffix = Number(id.slice(id.lastIndexOf("-") + 1));
  return Number.isFinite(suffix) ? suffix : 0;
}

/** Loads the run, mutates it, and persists. Throws for unknown ids. Mutations are serialized per run. */
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, apply: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(apply, apply);
  locks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

export async function updateRun(
  storage: StorageLike,
  id: string,
  apply: (run: RunState) => Promise<void> | void,
): Promise<RunState> {
  return withLock(id, async () => {
    const run = await getRun(storage, id);
    if (!run) {
      throw new Error(`unknown run ${id}`);
    }
    await apply(run);
    run.updatedAt = createdMs();
    await storage.set(keyFor(id), serialize(run));
    return run;
  });
}

export async function recordEvent(run: RunState, kind: string, detail: string): Promise<void> {
  run.events.push({ at: Date.now(), kind, detail });
  if (run.events.length > 200) {
    run.events.splice(0, run.events.length - 200);
  }
}
