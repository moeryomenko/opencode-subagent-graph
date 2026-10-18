import { Plugin } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { ToolEditor } from "@opencode/plugin/promise/tool";
import { mkdir, writeFile } from "node:fs/promises";
import { createRegistry, type RegistryDeps, type StartInput } from "./registry.ts";
import type { OpenCodeSessionApi } from "../opencode-session.ts";
import type { StorageLike } from "../store.ts";
import type { TaskSpec } from "../types.ts";

/** Narrow readers for the JSON-schema tool inputs. */
function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw new Error(`input ${key} must be a string`);
  }
  return value;
}

function readOptionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function readOptionalNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readRunID(input: Record<string, unknown>): string {
  return readString(input, "runID");
}

function readTasks(input: Record<string, unknown>): TaskSpec[] {
  const raw = input.tasks;
  if (!Array.isArray(raw)) {
    throw new Error("input tasks must be an array");
  }
  return raw.map((entry): TaskSpec => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("each task must be an object");
    }
    const task = entry as Record<string, unknown>;
    const id = readString(task, "id");
    const title = readString(task, "title");
    const prompt = readString(task, "prompt");
    if (!Array.isArray(task.dependsOn)) {
      throw new Error(`task ${id} dependsOn must be an array`);
    }
    const dependsOn = task.dependsOn.map((dep) => {
      if (typeof dep !== "string") {
        throw new Error(`task ${id} dependsOn must contain strings`);
      }
      return dep;
    });
    return {
      id,
      title,
      prompt,
      dependsOn,
      model: readOptionalString(task, "model"),
    };
  });
}

function readStart(input: Record<string, unknown>): StartInput {
  const budgetUSD = readOptionalNumber(input, "budgetUSD");
  return {
    goal: readString(input, "goal"),
    tasks: readTasks(input),
    budgetUSD: budgetUSD ?? 0.5,
    integrationBranch: readOptionalString(input, "integrationBranch") ?? "orchestrator/integration",
    engineerAgent: readOptionalString(input, "engineerAgent"),
    modelChain: input.modelChain !== undefined
      ? readString(input, "modelChain").split(",")
      : undefined,
    maxAttempts: readOptionalNumber(input, "maxAttempts"),
    maxParallel: readOptionalNumber(input, "maxParallel"),
  };
}

async function runTool(step: () => Promise<unknown>): Promise<{ content: string }> {
  try {
    const result = await step();
    return { content: JSON.stringify(result, null, 2) };
  } catch (error) {
    return { content: `error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export default Plugin.define({
  id: "subagent-graph",
  async setup(context: Context) {
    const deps: RegistryDeps = {
      storage: adaptStorage(context),
      sessions: context.session as unknown as OpenCodeSessionApi,
      directory: context.location.directory,
      writeReport: (path, html) => writeReportFile(path, html),
    };

    const registry = createRegistry(deps);
    const reconciliation = await registry.reconcile();

    await context.tool.transform((editor: ToolEditor) => {
      editor.namespace({
        name: "orchestrator",
        description: "Create and control subagent graph runs. Write task titles and prompts in simplified technical English.",
      });

      editor.add({
        name: "start",
        description: "Create an orchestration run from a task graph. Supplies goal, tasks, budget in USD, integration branch, and escalation chain.",
        input: {
          type: "object",
          properties: {
            goal: { type: "string" },
            tasks: { type: "array" },
            budgetUSD: { type: "number" },
            integrationBranch: { type: "string" },
            engineerAgent: { type: "string" },
            modelChain: { type: "string" },
            maxAttempts: { type: "number" },
            maxParallel: { type: "number" },
          },
          required: ["goal", "tasks"],
        },
        options: { namespace: "orchestrator" },
        async execute(input: unknown) {
          return runTool(() => registry.start(readStart(input as Record<string, unknown>)));
        },
      });

      editor.add({
        name: "approve",
        description: "Approve a graph and start executing its subtasks.",
        input: {
          type: "object",
          properties: { runID: { type: "string", minLength: 1 } },
          required: ["runID"],
        },
        options: { namespace: "orchestrator" },
        async execute(input: unknown) {
          return runTool(() => registry.approve(readRunID(input as Record<string, unknown>)));
        },
      });

      editor.add({
        name: "status",
        description: "Show status of one run or a summary of all runs.",
        input: {
          type: "object",
          properties: { runID: { type: "string" } },
        },
        options: { namespace: "orchestrator" },
        async execute(input: unknown) {
          return runTool(() => registry.status(readOptionalString(input as Record<string, unknown>, "runID")));
        },
      });

      editor.add({
        name: "pause",
        description: "Pause a run. In-progress sessions are interrupted and their tasks requeued.",
        input: {
          type: "object",
          properties: { runID: { type: "string", minLength: 1 } },
          required: ["runID"],
        },
        options: { namespace: "orchestrator" },
        async execute(input: unknown) {
          return runTool(() => registry.pause(readRunID(input as Record<string, unknown>)));
        },
      });

      editor.add({
        name: "resume",
        description: "Resume a paused run; optionally raise its budget in USD.",
        input: {
          type: "object",
          properties: { runID: { type: "string", minLength: 1 }, raiseBudgetTo: { type: "number" } },
          required: ["runID"],
        },
        options: { namespace: "orchestrator" },
        async execute(input: unknown) {
          return runTool(() =>
            registry.resume(
              readRunID(input as Record<string, unknown>),
              readOptionalNumber(input as Record<string, unknown>, "raiseBudgetTo"),
            ),
          );
        },
      });

      editor.add({
        name: "cancel",
        description: "Cancel a run; nothing else is dispatched afterwards.",
        input: {
          type: "object",
          properties: { runID: { type: "string", minLength: 1 } },
          required: ["runID"],
        },
        options: { namespace: "orchestrator" },
        async execute(input: unknown) {
          return runTool(() => registry.cancel(readRunID(input as Record<string, unknown>)));
        },
      });

      editor.add({
        name: "scope_exception",
        description: "Record a user-approved exception to the task scope.",
        input: {
          type: "object",
          properties: {
            runID: { type: "string", minLength: 1 },
            detail: { type: "string", minLength: 1 },
            taskID: { type: "string" },
          },
          required: ["runID", "detail"],
        },
        options: { namespace: "orchestrator" },
        async execute(input: unknown) {
          return runTool(() =>
            registry.scopeException(
              readRunID(input as Record<string, unknown>),
              readString(input as Record<string, unknown>, "detail"),
              readOptionalString(input as Record<string, unknown>, "taskID"),
            ),
          );
        },
      });

      editor.add({
        name: "replan",
        description: "Append tasks to a run that is awaiting approval or running.",
        input: {
          type: "object",
          properties: { runID: { type: "string", minLength: 1 }, tasks: { type: "array" } },
          required: ["runID", "tasks"],
        },
        options: { namespace: "orchestrator" },
        async execute(input: unknown) {
          return runTool(() =>
            registry.replan(
              readRunID(input as Record<string, unknown>),
              readTasks(input as Record<string, unknown>),
            ),
          );
        },
      });

      editor.add({
        name: "report",
        description: "Write a static HTML report for one run (or the latest run) and return its path.",
        input: {
          type: "object",
          properties: { runID: { type: "string" } },
        },
        options: { namespace: "orchestrator" },
        async execute(input: unknown) {
          return runTool(() => registry.report(readOptionalString(input as Record<string, unknown>, "runID")));
        },
      });
    });

    if (reconciliation.resumed.length > 0) {
      console.error(
        `[subagent-graph] resumed runs after restart: ${reconciliation.resumed.join(", ")}`,
      );
    }
  },
});

function adaptStorage(context: Context): StorageLike {
  return {
    get: (key) => context.storage.get(key),
    set: async (key, value) => {
      if (typeof value !== "string") {
        throw new Error("storage values must be JSON strings");
      }
      await context.storage.set(key, value as never);
    },
    scan: async (options) => {
      const scanResult = await context.storage.scan(options);
      return scanResult.entries.map((entry) => ({ key: entry.key, value: entry.value }));
    },
  };
}

async function writeReportFile(path: string, html: string): Promise<void> {
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await writeFile(path, html, "utf8");
}
