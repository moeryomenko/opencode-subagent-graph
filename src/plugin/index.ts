import { Plugin } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { ToolContext, ToolEditor } from "@opencode/plugin/promise/tool";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRegistry, type RegistryDeps, type StartInput } from "./registry.ts";
import { orchestratorRpc } from "./rpc.ts";
import {
  makeSessionClient,
  type BuiltinSubagentTool,
  type OpenCodeSessionApi,
  type SubagentToolContext,
} from "../opencode-session.ts";
import type { StorageLike } from "../store.ts";
import type { TaskSpec } from "../types.ts";
import { classifyComplexity, validateModelPolicy } from "../model-policy.ts";

const execFileAsync = promisify(execFile);

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

export function readTasks(input: Record<string, unknown>): TaskSpec[] {
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
    const role = readOptionalString(task, "role");
    if (role !== undefined && !["engineer", "researcher", "explorer", "classifier"].includes(role)) {
      throw new Error(`task ${id} role must be engineer, researcher, explorer, or classifier`);
    }
    return {
      id,
      title,
      prompt,
      dependsOn,
      model: readOptionalString(task, "model"),
      role: role as TaskSpec["role"],
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
    const pluginOptions = context.options as unknown as Record<string, unknown>;
    const modelPolicy = pluginOptions.models === undefined ? undefined : validateModelPolicy(pluginOptions.models);
    let classifierClient: ReturnType<typeof makeSessionClient> | undefined;
    const deps: RegistryDeps = {
      storage: adaptStorage(context),
      sessions: context.session as unknown as OpenCodeSessionApi,
      directory: context.location.directory,
      modelPolicy,
      classify: async (task, model) => {
        if (!classifierClient) throw new Error("classifier dispatch is not active");
        const result = await classifierClient.run({
          title: `Classify ${task.id}`,
          agent: "classifier",
          model,
          directory: context.location.directory,
          prompt: `Classify task complexity. Return exactly {"complexity":"simple"|"medium"|"complex"}.\nTitle: ${task.title}\nPrompt: ${task.prompt}\nDependencies: ${task.dependsOn.length}`,
        });
        return { complexity: classifyComplexity(result.output ?? ""), costUSD: result.costUSD };
      },
      createWorktree: async (input) => {
        const created = await context.worktree.create({
        projectID: context.location.project.id,
        name: input.name,
        from: input.from,
        });
        await execFileAsync("git", ["-C", created.directory, "checkout", "-b", input.name]);
        return created;
      },
      integrateWorktree: async (input) => {
        await execFileAsync("git", ["-C", input.directory, "add", "-A"]);
        await execFileAsync("git", ["-C", input.directory, "commit", "-m", `orchestrator: integrate ${input.targetBranch}`]);
        const { stdout: branch } = await execFileAsync("git", ["-C", input.directory, "branch", "--show-current"]);
        await execFileAsync("git", ["-C", context.location.directory, "merge", "--no-ff", "--no-edit", branch.trim()]);
      },
      writeReport: (path, html) => writeReportFile(path, html),
    };

    const registry = createRegistry(deps);
    const reconciliation = await registry.reconcile();
    await registerAssets(context, registry);
    await context.rpc.register(orchestratorRpc, {
      async snapshot(input: unknown) {
        const sessionID = readString(input as Record<string, unknown>, "sessionID");
        return { status: await registry.statusForSession(sessionID) };
      },
    } as never);

      await context.tool.transform((editor: ToolEditor) => {
      editor.namespace({
        name: "orchestrator",
        description: "Create and control subagent graph runs. Write task titles and prompts in simplified technical English.",
      });

      const builtinSubagent = editor.get("subagent");
      const clientFor = (toolContext: ToolContext) => {
        if (!builtinSubagent) {
          throw new Error("the builtin subagent tool is not available");
        }
        classifierClient = makeSessionClient(
          context.session as unknown as OpenCodeSessionApi,
          builtinSubagent as unknown as BuiltinSubagentTool,
          toolContext as unknown as SubagentToolContext,
        );
        return classifierClient;
      };

      editor.add({
        name: "start",
        description: "Create an orchestration run from a task graph. Supplies goal, tasks, budget in USD, integration branch, and escalation chain.",
        input: {
          type: "object",
          properties: {
            goal: { type: "string" },
            tasks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                  prompt: { type: "string" },
                  dependsOn: { type: "array", items: { type: "string" } },
                  model: { type: "string" },
                  role: { type: "string", enum: ["engineer", "researcher", "explorer", "classifier"] },
                },
                required: ["id", "title", "prompt", "dependsOn"],
              },
            },
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
        async execute(input: unknown, toolContext: ToolContext) {
          const start = readStart(input as Record<string, unknown>);
          start.owner = {
            sessionID: toolContext.sessionID,
            agent: toolContext.agent,
            directory: context.location.directory,
          };
          return runTool(async () => {
            const created = await registry.start(start);
            await context.session.synthetic({
              sessionID: toolContext.sessionID,
              text: `Orchestrator run ${created.runID} is ready for approval.`,
              delivery: "queue",
              resume: false,
            });
            return created;
          });
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
        async execute(input: unknown, toolContext: ToolContext) {
          return runTool(async () => {
            const approved = await registry.approve(readRunID(input as Record<string, unknown>), clientFor(toolContext), {
              sessionID: toolContext.sessionID,
              agent: toolContext.agent,
              directory: context.location.directory,
            });
            await context.session.synthetic({
              sessionID: toolContext.sessionID,
              text: `Orchestrator run ${approved.runID} started.`,
              delivery: "queue",
              resume: false,
            });
            return approved;
          });
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

interface CommandRegistry {
  status(runID?: string): Promise<unknown>;
  report(runID?: string): Promise<string>;
}

async function registerAssets(context: Context, registry: CommandRegistry): Promise<void> {
  const asset = async (relativePath: string) => {
    const url = new URL(`../../resources/${relativePath}`, import.meta.url);
    return { path: url.pathname, content: await readFile(url, "utf8") };
  };
  const planToDag = await asset("skills/plan-to-dag/SKILL.md");
  const runControl = await asset("skills/run-control/SKILL.md");

  await context.skill.transform((editor) => {
    editor.add({
      id: "plan-to-dag",
      name: "plan-to-dag",
      description: "Convert an approved implementation plan into an orchestration task graph.",
      path: planToDag.path,
      content: planToDag.content,
    } as never);
    editor.add({
      id: "run-control",
      name: "run-control",
      description: "Control and inspect a subagent graph run.",
      path: runControl.path,
      content: runControl.content,
    } as never);
  });

  await context.command.transform((editor) => {
    editor.add({
      name: "orchestrate",
      description: "Plan and approve an orchestration run for a goal.",
      async execute(input) {
        await context.session.synthetic({
          sessionID: input.sessionID,
          text: `Create an orchestration plan for this goal. Do not approve the task graph until the user approves it.\n\nGoal:\n${JSON.stringify(input.prompt)}`,
          delivery: "steer",
        });
      },
    });
    editor.add({
      name: "orchestrator-status",
      description: "Show orchestration status without a model request.",
      async execute(input) {
        await context.session.synthetic({
          sessionID: input.sessionID,
          text: JSON.stringify(await registry.status(), null, 2),
          delivery: "queue",
          resume: false,
        });
      },
    });
    editor.add({
      name: "orchestrator-report",
      description: "Write an orchestration HTML report without a model request.",
      async execute(input) {
        const path = await registry.report();
        await context.session.synthetic({
          sessionID: input.sessionID,
          text: `Report written to ${path}`,
          delivery: "queue",
          resume: false,
        });
      },
    });
  });
}

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
