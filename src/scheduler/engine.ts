import { isRunFinished, readyTasks } from "../plan.ts";
import { getRun, recordEvent, updateRun, type StorageLike } from "../store.ts";
import type { Attempt, ModelRef, RunState, TaskState } from "../types.ts";
import { complexityTier, nextTier, selectPolicyEntry, type ModelPolicyEntry } from "../model-policy.ts";

export interface SessionHandle {
  id: string;
  outcome: "succeeded" | "failed" | "interrupted";
  costUSD: number;
  tokens: { input: number; output: number };
  output?: string;
}

/** Minimal session surface the engine needs. */
export interface SessionClientLike {
  run(input: {
    title: string;
    agent: string;
    model: ModelRef;
    directory: string;
    prompt: string;
    worktree?: boolean;
    /** Called as soon as the builtin tool reports the child session. */
    onStarted?: (sessionID: string) => Promise<void>;
  }): Promise<SessionHandle>;
}

export interface EngineOptions {
  workdir: string;
  agent: string;
  /** Escalation chain used by tasks without a per-task model. */
  modelChain: ModelRef[];
  modelPolicy?: ModelPolicyEntry[];
  classify?: (task: TaskState, model: ModelRef) => Promise<{ complexity?: "simple" | "medium" | "complex"; costUSD?: number }>;
  createWorktree?: (input: { name: string; from?: string; branch?: string }) => Promise<{ directory: string }>;
  integrateWorktree?: (input: { directory: string; targetBranch: string }) => Promise<void>;
  maxAttempts?: number;
  maxParallel?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_PARALLEL = 3;

/** Guards against two drivers picking up the same run concurrently in this process. */
const drivers = new Set<string>();

export async function driveRun(
  storage: StorageLike,
  runID: string,
  client: SessionClientLike,
  options: EngineOptions,
): Promise<void> {
  if (drivers.has(runID)) {
    return; // another driver owns this run in this process
  }
  drivers.add(runID);
  try {
    await driveLoop(storage, runID, client, options);
  } finally {
    drivers.delete(runID);
  }
}

async function driveLoop(
  storage: StorageLike,
  runID: string,
  client: SessionClientLike,
  options: EngineOptions,
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxParallel = options.maxParallel ?? DEFAULT_MAX_PARALLEL;

  for (;;) {
    let run = await getRun(storage, runID);
    if (!run) {
      throw new Error(`unknown run ${runID}`);
    }

    if (run.status === "awaiting_approval") {
      await updateRun(storage, runID, async (current) => {
        if (current.status === "awaiting_approval") {
          current.status = "running";
          await recordEvent(current, "started", "approval accepted");
        }
      });
      run = await getRun(storage, runID);
      if (!run || run.status !== "running") {
        return;
      }
    }

    if (run.status !== "running" || isRunFinished(run)) {
      return;
    }

    run = await updateRun(storage, runID, async (current) => {
      await markBlocked(current);
    });

    const dispatchable = readyTasks(run).slice(0, maxParallel);
    if (dispatchable.length > 0) {
      await Promise.all(
        dispatchable.map((task) => executeTask(storage, runID, task.id, client, options, maxAttempts)),
      );
      continue;
    }

    if (isRunFinished(run)) {
      await updateRun(storage, runID, async (current) => {
        if (current.status === "running") {
          current.status = "completed";
          await recordEvent(
            current,
            "completed",
            current.tasks.some((task) => task.status === "failed")
              ? "finished with failed tasks"
              : "all tasks passed",
          );
        }
      });
      return;
    }

    if (hasUnfinishedWork(run)) {
      // Everything remaining waits behind in-progress or blocked tasks; parked here.
      return;
    }

    await updateRun(storage, runID, async (current) => {
      if (current.status === "running") {
        current.status = "paused";
        await recordEvent(current, "parked", "no dispatchable tasks remain");
      }
    });
    return;
  }
}

/** Transitive blocking: a task with a failed dependency cannot run. */
async function markBlocked(run: RunState) {
  const failed = new Set(run.tasks.filter((task) => task.status === "failed").map((task) => task.id));
  const blocked = new Set(run.tasks.filter((task) => task.status === "blocked").map((task) => task.id));
  for (const task of run.tasks) {
    if (task.status !== "pending") continue;
    const dependsOnFailure = task.dependsOn.some((dep) => failed.has(dep) || blocked.has(dep));
    if (dependsOnFailure) {
      task.status = "blocked";
      await recordEvent(run, "task_blocked", `${task.id} blocked by failed dependency`);
    }
  }
}

async function executeTask(
  storage: StorageLike,
  runID: string,
  taskID: string,
  client: SessionClientLike,
  options: EngineOptions,
  maxAttempts: number,
): Promise<void> {
  for (;;) {
    let run = await getRun(storage, runID);
    if (!run || run.status !== "running") {
      return;
    }

    const task = run.tasks.find((candidate) => candidate.id === taskID);
    if (!task || task.status !== "pending") {
      return;
    }

    if (run.costUSD >= run.budgetUSD) {
      await updateRun(storage, runID, async (current) => {
        current.status = "paused";
        await recordEvent(current, "budget_stopped", `cost ${current.costUSD} reached budget ${current.budgetUSD}`);
      });
      return;
    }

    const outcome = await attemptTask(storage, runID, taskID, client, options, maxAttempts);
    if (outcome !== "retry") {
      return;
    }
  }
}

async function attemptTask(
  storage: StorageLike,
  runID: string,
  taskID: string,
  client: SessionClientLike,
  options: EngineOptions,
  maxAttempts: number,
): Promise<"retry" | "done"> {
  let run = await getRun(storage, runID);
  if (!run || run.status !== "running") {
    return "done";
  }
  const task = run.tasks.find((candidate) => candidate.id === taskID);
  if (!task) {
    return "done";
  }

  if (options.modelPolicy?.length && !task.model && !task.complexity) {
    const cheapest = options.modelPolicy.find((entry) => entry.budget === "cheaper") ?? options.modelPolicy[0];
    let complexity: "simple" | "medium" | "complex" | undefined = options.classify
      ? undefined
      : task.prompt.length < 500 && task.dependsOn.length === 0 ? "simple" : "medium";
    if (options.classify && cheapest) {
      try {
        const classification = await options.classify(task, cheapest.model);
        complexity = classification.complexity;
        if (classification.costUSD) {
          await updateRun(storage, runID, async (current) => { current.costUSD += classification.costUSD ?? 0; });
        }
      } catch { /* medium fallback */ }
    }
    await updateRun(storage, runID, async (current) => {
      const currentTask = current.tasks.find((candidate) => candidate.id === taskID);
      if (!currentTask) return;
      currentTask.complexity = complexity ?? "medium";
      current.complexity ??= {};
      current.complexity[taskID] = currentTask.complexity;
      await recordEvent(current, "task_classified", `${taskID} -> ${currentTask.complexity}`);
    });
  }
  run = await getRun(storage, runID);
  if (!run || run.status !== "running") return "done";
  const classifiedTask = run.tasks.find((candidate) => candidate.id === taskID);
  if (!classifiedTask) return "done";
  // Reserve the slot before any network work.
  const selectedModel = modelFor(classifiedTask, options);
  const attempt: Attempt = { model: selectedModel, budget: options.modelPolicy?.find((entry) => entry.model === selectedModel)?.budget, startedAt: Date.now() };
  let directory = options.workdir;
  if (classifiedTask.role === "explorer" && options.createWorktree) {
    directory = (await options.createWorktree({ name: `${runID}-${taskID}`, from: options.workdir })).directory;
    await updateRun(storage, runID, async (current) => { current.worktrees[taskID] = directory; });
  }
  run = await updateRun(storage, runID, async (current) => {
    const currentTask = current.tasks.find((candidate) => candidate.id === taskID);
    if (!currentTask) return;
    currentTask.attempts.push(attempt);
    currentTask.status = "in_progress";
    await recordEvent(current, "attempt", `${taskID} -> ${attempt.model}`);
  });

  try {
    const handle = await client.run({
      title: `${run?.goal ?? runID} / ${taskID}`,
      agent: classifiedTask.role ?? options.agent,
      model: attempt.model,
      directory,
      prompt: task.prompt,
      worktree: classifiedTask.role === "explorer",
      onStarted: async (sessionID) => {
        await updateRun(storage, runID, async (current) => {
          const currentTask = current.tasks.find((candidate) => candidate.id === taskID);
          const currentAttempt = currentTask?.attempts.at(-1);
          if (currentTask?.status === "in_progress" && currentAttempt && !currentAttempt.sessionID) {
            currentAttempt.sessionID = sessionID;
            await recordEvent(current, "child_started", `${taskID} -> ${sessionID}`);
          }
        });
      },
    });
    return await settleTask(storage, runID, taskID, {
      success: handle.outcome === "succeeded",
      session: {
        id: handle.id,
        finishedAt: Date.now(),
        outcome: handle.outcome === "succeeded" ? "passed" : "failed",
        costUSD: handle.costUSD,
        tokens: handle.tokens,
      },
      maxAttempts,
      integrationBranch: run?.integrationBranch,
      integrateWorktree: options.integrateWorktree,
      worktree: run?.worktrees[taskID],
    });
  } catch (error) {
    return await settleTask(storage, runID, taskID, {
      success: false,
      session: { id: "", finishedAt: Date.now(), outcome: "failed" },
      maxAttempts,
      integrationBranch: run?.integrationBranch,
      integrateWorktree: options.integrateWorktree,
      worktree: run?.worktrees[taskID],
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function settleTask(
  storage: StorageLike,
  runID: string,
  taskID: string,
  input: {
    success: boolean;
    session: { id: string; finishedAt: number; outcome: "passed" | "failed"; costUSD?: number; tokens?: { input: number; output: number } };
    maxAttempts: number;
    error?: string;
    integrationBranch?: string;
    integrateWorktree?: (input: { directory: string; targetBranch: string }) => Promise<void>;
    worktree?: string;
  },
): Promise<"retry" | "done"> {
  let willRetry = false;
  await updateRun(storage, runID, async (run) => {
    const task = run.tasks.find((candidate) => candidate.id === taskID);
    if (!task) return;

    const attempt = task.attempts.at(-1);
    if (attempt) {
      attempt.finishedAt = input.session.finishedAt;
      attempt.outcome = input.session.outcome;
      if (input.session.costUSD !== undefined) {
        attempt.costUSD = input.session.costUSD;
        run.costUSD += input.session.costUSD;
      }
      if (input.session.tokens) {
        attempt.tokens = input.session.tokens;
      }
      if (input.session.id) {
        attempt.sessionID = input.session.id;
      }
    }

    // A cancelled run records cost only. A paused run settles active children,
    // but does not dispatch their dependants until it resumes.
    if (run.status === "cancelled") {
      return;
    }

    if (input.success) {
      if (input.worktree && input.integrateWorktree && input.integrationBranch) {
        await input.integrateWorktree({ directory: input.worktree, targetBranch: input.integrationBranch });
      }
      task.status = "passed";
      await recordEvent(run, "task_passed", taskID);
    } else {
      willRetry = task.attempts.length < input.maxAttempts;
      task.status = willRetry ? "pending" : "failed";
      await recordEvent(
        run,
        "task_failed_attempt",
        `${taskID} (${input.error ?? input.session.outcome}, model ${attempt?.model})`,
      );
      if (!willRetry) {
        await markBlocked(run);
      }
    }

    if (run.costUSD >= run.budgetUSD && run.status === "running") {
      run.status = "paused";
      await recordEvent(run, "budget_stopped", `cost ${run.costUSD} reached budget ${run.budgetUSD}`);
      return;
    }

    if (isRunFinished(run) && run.status === "running") {
      run.status = "completed";
      await recordEvent(
        run,
        "completed",
        run.tasks.some((task) => task.status === "failed") ? "finished with failed tasks" : "all tasks passed",
      );
    }
  });

  return input.success || !willRetry ? "done" : "retry";
}

function modelFor(task: TaskState, options: EngineOptions): ModelRef {
  if (task.model) {
    return task.model;
  }
  if (options.modelPolicy && options.modelPolicy.length > 0) {
    const complexity = task.complexity ?? "medium";
    const preferred = complexityTier(complexity);
    const attemptsByModel = Object.fromEntries(task.attempts.map((attempt) => [attempt.model,
      task.attempts.filter((candidate) => candidate.model === attempt.model).length]));
    const previous = task.attempts.at(-1);
    const previousEntry = previous && options.modelPolicy.find((entry) => entry.model === previous.model);
    const previousAttempts = previous ? attemptsByModel[previous.model] ?? 0 : 0;
    const escalation = previousEntry && previousAttempts >= previousEntry.retry
      ? nextTier(options.modelPolicy, previousEntry.budget)
      : undefined;
    const selected = selectPolicyEntry(options.modelPolicy, escalation ?? previousEntry?.budget ?? preferred, attemptsByModel);
    return selected?.model
      ?? options.modelPolicy.find((entry) => entry.budget === "expensive")?.model
      ?? options.modelPolicy.at(-1)?.model
      ?? options.modelChain[0];
  }
  const index = Math.min(task.attempts.length, options.modelChain.length - 1);
  return options.modelChain[index] ?? options.modelChain[0];
}

function hasUnfinishedWork(run: RunState): boolean {
  return run.tasks.some((task) => task.status === "in_progress" || task.status === "pending");
}
