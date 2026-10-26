import type { PlanInput, RunState, TaskSpec, TaskState } from "./types.ts";

export class PlanError extends Error {}

const MAX_TASKS = 64;

/** Validates a plan DAG and returns its task ids in dependency order. */
export function validatePlan(plan: PlanInput): string[] {
  if (!Array.isArray(plan.tasks)) {
    throw new PlanError("plan.tasks must be an array");
  }
  if (plan.tasks.length === 0) {
    throw new PlanError("empty task list");
  }
  if (plan.tasks.length > MAX_TASKS) {
    throw new PlanError(`task limit is ${MAX_TASKS} tasks`);
  }

  const ids = new Set<string>();
  for (const task of plan.tasks) {
    if (ids.has(task.id)) {
      throw new PlanError(`duplicate task id ${task.id}`);
    }
    if (typeof task.id !== "string" || task.id.length === 0) {
      throw new PlanError("task id must be a non-empty string");
    }
    if (typeof task.title !== "string" || task.title.trim().length === 0) {
      throw new PlanError(`task ${task.id} has an empty title`);
    }
    if (typeof task.prompt !== "string" || task.prompt.trim().length === 0) {
      throw new PlanError(`task ${task.id} has an empty prompt`);
    }
    if (task.model !== undefined && typeof task.model !== "string") {
      throw new PlanError(`task ${task.id} has a non-string model`);
    }
    if (task.role !== undefined && !["engineer", "researcher", "explorer", "classifier"].includes(task.role)) {
      throw new PlanError(`task ${task.id} has an invalid role`);
    }
    ids.add(task.id);
  }

  for (const task of plan.tasks) {
    if (!Array.isArray(task.dependsOn)) {
      throw new PlanError(`task ${task.id} dependsOn must be an array`);
    }
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        throw new PlanError(`task ${task.id} has unknown dependency ${dep}`);
      }
    }
  }

  return topologicalOrder(plan.tasks);
}

function topologicalOrder(tasks: TaskSpec[]): string[] {
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const task of tasks) {
    indegree.set(task.id, task.dependsOn.length);
    for (const dep of task.dependsOn) {
      const list = outgoing.get(dep) ?? [];
      list.push(task.id);
      outgoing.set(dep, list);
    }
  }

  const queue = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id);
  const ordered: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    ordered.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        queue.push(next);
      }
    }
  }

  if (ordered.length !== tasks.length) {
    const cycle = tasks.filter((task) => (indegree.get(task.id) ?? 0) > 0).map((task) => task.id);
    throw new PlanError(`dependency cycle between tasks ${cycle.join(", ")}`);
  }
  return ordered;
}

/** Prepare validated runtime task state from a plan. */
export function toTaskStates(plan: PlanInput): TaskState[] {
  validatePlan(plan);
  return plan.tasks.map((task) => ({
    ...task,
    dependsOn: [...task.dependsOn],
    status: "pending" as const,
    attempts: [],
  }));
}

/** Ids of tasks whose dependencies all passed and that are not done. */
export function readyTasks(run: RunState): TaskState[] {
  const passed = new Set(run.tasks.filter((task) => task.status === "passed").map((task) => task.id));
  const failed = run.tasks.some((task) => task.status === "failed" || task.status === "blocked");
  if (failed && run.tasks.every((task) => task.status === "pending" || task.status === "failed" || task.status === "blocked")) {
    return [];
  }
  return run.tasks.filter(
    (task) =>
      task.status === "pending" &&
      task.dependsOn.every((dep) => passed.has(dep)),
  );
}

/** True when no task is pending, in progress, or blocked. */
export function isRunFinished(run: RunState): boolean {
  return run.tasks.every((task) => task.status === "passed" || task.status === "failed");
}
