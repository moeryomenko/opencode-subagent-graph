import { isRunFinished, readyTasks } from "../plan.ts";
import { getRun, recordEvent, updateRun, type StorageLike } from "../store.ts";
import type { Attempt, ModelRef, RunState, TaskState } from "../types.ts";

export interface SessionHandle {
  id: string;
  outcome: "succeeded" | "failed" | "interrupted";
  costUSD: number;
  tokens: { input: number; output: number };
}

/** Minimal session surface the engine needs. */
export interface SessionClientLike {
  run(input: {
    title: string;
    agent: string;
    model: ModelRef;
    directory: string;
    prompt: string;
    /** Called as soon as the builtin tool reports the child session. */
    onStarted?: (sessionID: string) => Promise<void>;
  }): Promise<SessionHandle>;
}

export interface EngineOptions {
  workdir: string;
  agent: string;
  /** Escalation chain used by tasks without a per-task model. */
  modelChain: ModelRef[];
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

  // Reserve the slot before any network work.
  const attempt: Attempt = { model: modelFor(task, options.modelChain), startedAt: Date.now() };
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
      agent: options.agent,
      model: attempt.model,
      directory: options.workdir,
      prompt: task.prompt,
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
    });
  } catch (error) {
    return await settleTask(storage, runID, taskID, {
      success: false,
      session: { id: "", finishedAt: Date.now(), outcome: "failed" },
      maxAttempts,
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

function modelFor(task: TaskState, modelChain: ModelRef[]): ModelRef {
  if (task.model) {
    return task.model;
  }
  const index = Math.min(task.attempts.length, modelChain.length - 1);
  return modelChain[index] ?? modelChain[0];
}

function hasUnfinishedWork(run: RunState): boolean {
  return run.tasks.some((task) => task.status === "in_progress" || task.status === "pending");
}
