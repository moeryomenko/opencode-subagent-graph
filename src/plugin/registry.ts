import { driveRun, type EngineOptions, type SessionClientLike } from "../scheduler/engine.ts";
import { makeSessionClient, type OpenCodeSessionApi, type OrchestratorSessionClient } from "../opencode-session.ts";
import { createRun, getRun, listRuns, recordEvent, updateRun, type StorageLike } from "../store.ts";
import { toTaskStates, validatePlan } from "../plan.ts";
import type { RunOwner, RunState, TaskSpec } from "../types.ts";

export interface RegistryDeps {
  storage: StorageLike;
  sessions: OpenCodeSessionApi;
  /** Project root that engineer sessions run in. */
  directory: string;
  /** Persist a static HTML report; returns the written path. */
  writeReport: (path: string, html: string) => Promise<void>;
}

export interface StartInput {
  goal: string;
  budgetUSD: number;
  integrationBranch: string;
  tasks: TaskSpec[];
  engineerAgent?: string;
  modelChain?: string[];
  maxAttempts?: number;
  maxParallel?: number;
  owner?: RunOwner;
}

export interface RunDetail {
  runID: string;
  goal: string;
  status: string;
  costUSD: number;
  budgetUSD: number;
  integrationBranch: string;
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    attempts: number;
    lastAttempt: { model?: string; outcome?: string; sessionID?: string };
  }>;
  recentEvents: Array<{ at: number; kind: string; detail: string }>;
}

export interface RunsOverview {
  runs: Array<{
    runID: string;
    goal: string;
    status: string;
    costUSD: number;
    budgetUSD: number;
    tasksPassed: number;
    tasksTotal: number;
  }>;
}

/** Tracks spawn()ed drivers so tests and shutdown can wait for their settle. */
const activeDrivers = new Set<Promise<unknown>>();

/** Resolves once every spawned driver has finished its current pass. */
async function idleDriver(): Promise<void> {
  while (activeDrivers.size > 0) {
    const snapshots = [...activeDrivers];
    await Promise.allSettled(snapshots);
  }
}

const REPORT_FILE = "opencode-orchestrator-report.html";

export function createRegistry(deps: RegistryDeps) {
  const client = makeSessionClient(deps.sessions) as SessionClientLike & {
    interrupt: (sessionID: string) => Promise<void>;
  };

  const engineOptions = (run: RunState): EngineOptions => ({
    workdir: deps.directory,
    agent: run.engineerAgent,
    modelChain: run.modelChain,
    maxAttempts: run.maxAttempts,
    maxParallel: run.maxParallel,
  });

  function spawn(runID: string, driverClient: SessionClientLike = client) {
    const promise = (async () => {
      const run = await getRun(deps.storage, runID);
      if (!run) {
        return;
      }
      await driveRun(deps.storage, runID, driverClient, engineOptions(run));
    })().catch(() => undefined);
    activeDrivers.add(promise);
    void promise.then(
      () => activeDrivers.delete(promise),
      () => activeDrivers.delete(promise),
    );
  }

  async function requireRun(runID: string): Promise<RunState> {
    const run = await getRun(deps.storage, runID);
    if (!run) {
      throw new Error(`unknown run ${runID}`);
    }
    return run;
  }

  function runSummary(run: RunState) {
    return {
      runID: run.id,
      goal: run.goal,
      status: run.status,
      costUSD: run.costUSD,
      budgetUSD: run.budgetUSD,
      integrationBranch: run.integrationBranch,
      tasks: run.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        attempts: task.attempts.length,
        lastAttempt: {
          model: task.attempts.at(-1)?.model,
          outcome: task.attempts.at(-1)?.outcome,
          sessionID: task.attempts.at(-1)?.sessionID,
        },
      })),
      recentEvents: run.events.slice(-6),
    };
  }

  /** Live sessions of tasks that are currently in flight. */
  function activeSessionIDs(run: RunState): string[] {
    return run.tasks
      .filter((task) => task.status === "in_progress")
      .map((task) => task.attempts.at(-1)?.sessionID)
      .filter((sessionID): sessionID is string => typeof sessionID === "string" && sessionID.length > 0);
  }

  return {
    async start(input: StartInput) {
      validatePlan({ tasks: input.tasks });
      const created = await createRun(deps.storage, {
        goal: input.goal,
        budgetUSD: input.budgetUSD,
        integrationBranch: input.integrationBranch,
        tasks: input.tasks,
        engineerAgent: input.engineerAgent,
        modelChain: input.modelChain,
        maxAttempts: input.maxAttempts,
        maxParallel: input.maxParallel,
        owner: input.owner,
      });
      return {
        runID: created.id,
        status: created.status,
        tasks: created.tasks.map((task) => task.id),
        message: "Run created. Call orchestrator_approve to begin.",
      };
    },

    async approve(runID: string, driverClient?: OrchestratorSessionClient, caller?: RunOwner) {
      const run = await requireRun(runID);
      if (run.owner && caller && (run.owner.sessionID !== caller.sessionID || run.owner.agent !== caller.agent)) {
        throw new Error("only the session and agent that created the run can approve it");
      }
      if (run.status !== "awaiting_approval") {
        throw new Error(`run ${runID} is not awaiting approval (status ${run.status})`);
      }
      await updateRun(deps.storage, runID, async (current) => {
        if (current.status === "awaiting_approval") {
          current.status = "running";
          await recordEvent(current, "approved", "user approved the plan");
        }
      });
      spawn(runID, driverClient);
      return { runID, status: "running", message: "Run started." };
    },

    async pause(runID: string) {
      const run = await requireRun(runID);
      if (run.status !== "running" && run.status !== "awaiting_approval") {
        return { runID, status: run.status, message: "Run is not running." };
      }
      await updateRun(deps.storage, runID, async (current) => {
        if (current.status === "running" || current.status === "awaiting_approval") {
          current.status = "paused";
          await recordEvent(current, "paused", "user paused the run");
        }
      });
      return { runID, status: "paused" };
    },

    async resume(runID: string, raiseBudgetTo?: number) {
      const run = await requireRun(runID);
      if (run.status !== "paused") {
        throw new Error(`run ${runID} is not paused (status ${run.status})`);
      }
      if (
        typeof raiseBudgetTo === "number" &&
        raiseBudgetTo <= run.costUSD
      ) {
        throw new Error("raiseBudgetTo must exceed the spent cost");
      }
      await updateRun(deps.storage, runID, async (current) => {
        if (typeof raiseBudgetTo === "number") {
          current.budgetUSD = raiseBudgetTo;
          await recordEvent(current, "budget_raised", `budget raised to ${raiseBudgetTo}`);
        }
        if (current.costUSD >= current.budgetUSD) {
          throw new Error(
            `run ${runID} is parked at budget ${current.budgetUSD}; supply raiseBudgetTo to resume`,
          );
        }
        if (current.status === "paused") {
          current.status = "running";
          await recordEvent(current, "resumed", "user resumed the run");
        }
      });
      spawn(runID);
      return { runID, status: "running" };
    },

    async cancel(runID: string) {
      const run = await requireRun(runID);
      if (run.status === "completed" || run.status === "cancelled") {
        return { runID, status: run.status, message: "Run already finished." };
      }
      await updateRun(deps.storage, runID, async (current) => {
        if (current.status !== "completed" && current.status !== "cancelled") {
          current.status = "cancelled";
          await recordEvent(current, "cancelled", "user cancelled the run");
        }
      });
      for (const sessionID of activeSessionIDs(run)) {
        await client.interrupt(sessionID).catch(() => undefined);
      }
      return { runID, status: "cancelled" };
    },

    async scopeException(runID: string, detail: string, taskID?: string) {
      const run = await requireRun(runID);
      if (typeof detail !== "string" || detail.trim().length === 0) {
        throw new Error("empty exception detail");
      }
      if (taskID !== undefined && !run.tasks.some((task) => task.id === taskID)) {
        throw new Error(`run ${runID} has no task ${taskID}`);
      }
      const confirmed = detail.trim();
      await updateRun(deps.storage, runID, async (current) => {
        await recordEvent(current, "scope_exception", taskID ? `${taskID}: ${confirmed}` : confirmed);
      });
      return { runID, recorded: confirmed };
    },

    async replan(runID: string, tasks: TaskSpec[]) {
      const run = await requireRun(runID);
      if (run.status === "completed" || run.status === "cancelled") {
        throw new Error(`run ${runID} is ${run.status}; start a new run instead`);
      }
      const existingIDs = new Set([...run.tasks.map((task) => task.id)]);
      const declared = [...run.tasks, ...tasks];
      const overlapping = tasks.filter((task) => existingIDs.has(task.id));
      if (overlapping.length > 0) {
        throw new Error(`task ids already exist: ${overlapping.map((task) => task.id).join(", ")}`);
      }
      validatePlan({ tasks: declared });

      const existingStates = [...run.tasks];
      const additions = toTaskStates({ tasks }).filter((task) => !existingIDs.has(task.id));
      await updateRun(deps.storage, runID, (current) => {
        current.tasks = [...existingStates, ...additions];
        void recordEvent(current, "replanned", `added tasks ${additions.map((task) => task.id).join(", ")}`);
      });
      if (run.status === "running") {
        spawn(runID);
      }

      const fresh = await requireRun(runID);
      return { runID, tasks: fresh.tasks.map((task) => ({ id: task.id, status: task.status })) };
    },

    async status(runID?: string): Promise<RunDetail | RunsOverview> {
      if (runID !== undefined) {
        const run = await requireRun(runID);
        return runSummary(run);
      }
      const runs = await listRuns(deps.storage);
      return {
        runs: runs.map((run) => ({
          runID: run.id,
          goal: run.goal,
          status: run.status,
          costUSD: run.costUSD,
          budgetUSD: run.budgetUSD,
          tasksPassed: run.tasks.filter((task) => task.status === "passed").length,
          tasksTotal: run.tasks.length,
        })),
      };
    },

    async statusForSession(sessionID: string): Promise<RunsOverview> {
      const runs = (await listRuns(deps.storage)).filter((run) => run.owner?.sessionID === sessionID);
      return {
        runs: runs.map((run) => ({
          runID: run.id,
          goal: run.goal,
          status: run.status,
          costUSD: run.costUSD,
          budgetUSD: run.budgetUSD,
          tasksPassed: run.tasks.filter((task) => task.status === "passed").length,
          tasksTotal: run.tasks.length,
        })),
      };
    },

    async report(runID?: string) {
      const run = runID !== undefined ? await requireRun(runID) : (await listRuns(deps.storage))[0];
      if (!run) {
        throw new Error("no runs to report");
      }
      const html = renderReport(run);
      const path = `${deps.directory}/${REPORT_FILE}`;
      await deps.writeReport(path, html);
      return path;
    },

    async reconcile() {
      const runs = await listRuns(deps.storage);
      const resumed: string[] = [];
      for (const run of runs) {
        const orphaned = run.tasks.filter((task) => task.status === "in_progress");
        if (run.status === "running") {
          for (const task of orphaned) {
            await updateRun(deps.storage, run.id, async (current) => {
              const match = current.tasks.find((candidate) => candidate.id === task.id);
              if (match?.status === "in_progress") {
                await recordEvent(current, "reconciled", `${match.id} retains its child session after restart`);
              }
            });
          }
          if (run.tasks.some((task) => task.status === "pending")) {
            spawn(run.id);
            resumed.push(run.id);
          }
        }
      }
      return { resumed };
    },

    async idle() {
      await idleDriver();
    },
  };
}

function renderReport(run: RunState): string {
  const taskRows = run.tasks
    .map((task) => {
      const attempts = task.attempts.length;
      const last = task.attempts.at(-1);
      return `<tr><td>${task.id}</td><td>${task.dependsOn.join(", ") || "&mdash;"}</td><td>${task.status}</td><td>${attempts}</td><td>${last?.model ?? "&mdash;"}</td><td>${last?.outcome ?? "&mdash;"}</td><td>${last?.costUSD !== undefined ? last.costUSD.toFixed(4) : "&mdash;"}</td></tr>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Orchestrator report ${run.id}</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem; color: #222; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ccc; padding: .4rem .6rem; text-align: left; }
th { background: #f4f4f4; }
h1 { font-size: 1.4rem; }
</style></head>
<body>
<h1>${run.id}</h1>
<p><strong>Goal:</strong> ${run.goal}</p>
<p><strong>Status:</strong> ${run.status} &mdash; <strong>Cost:</strong> USD ${run.costUSD.toFixed(4)} of ${run.budgetUSD.toFixed(2)} &mdash; <strong>Branch:</strong> ${run.integrationBranch}</p>
<table>
<thead><tr><th>Task</th><th>Depends on</th><th>Status</th><th>Attempts</th><th>Last model</th><th>Last outcome</th><th>Last cost (USD)</th></tr></thead>
<tbody>
${taskRows}
</tbody>
</table>
<h2>Recent events</h2>
<ul>
${run.events.slice(-20).map((event) => `<li>${new Date(event.at).toISOString()} &mdash; ${event.kind} &mdash; ${event.detail.replace(/</g, "&lt;")}</li>`).join("\n")}
</ul>
</body>
</html>
`;
}
