import { describe, expect, test } from "bun:test";
import { MemoryStorage } from "../src/storage/memory.ts";
import { createRegistry, type RegistryDeps, type RunDetail } from "../src/plugin/registry.ts";
import { createRun, getRun, updateRun } from "../src/store.ts";
import type { TaskSpec } from "../src/types.ts";

const task = (id: string, deps: string[] = []): TaskSpec => ({
  id,
  title: `Task ${id}`,
  prompt: `Implement ${id}.`,
  dependsOn: deps,
});

const startInput = () => ({
  goal: "Ship the feature",
  budgetUSD: 0.5,
  integrationBranch: "orchestrator/run",
  tasks: [task("a")],
});

interface Latch {
  opened: boolean;
  waiters: Array<() => void>;
}

/** Session fake whose first session.wait blocks until the test opens it. */
function makeDeps(latch?: Latch): RegistryDeps & { reportPaths: string[]; latch: Latch } {
  const storage = new MemoryStorage();
  const reportPaths: string[] = [];
  const activeLatch: Latch = latch ?? { opened: true, waiters: [] };
  const sessions = {
    async create(input: { title?: string | null; agent?: string | null; model?: { id: string; providerID: string } | null; location?: { directory?: string | null } | null }) {
      void input;
      return { id: `ses_${crypto.randomUUID()}`, outcome: "succeeded" as const, cost: 0.01, tokens: { input: 5, output: 5 } };
    },
    async prompt() {
      if (!activeLatch.opened) {
        await new Promise<void>((resolve) => activeLatch.waiters.push(resolve));
      }
    },
    async wait() {},
    async get() {
      return { id: "ses", outcome: "succeeded" as const, cost: 0.01, tokens: { input: 5, output: 5 } };
    },
    async interrupt() {},
  };
  return {
    storage,
    sessions,
    directory: "/proj",
    async writeReport(path: string, _html: string) {
      void _html;
      reportPaths.push(path);
    },
    reportPaths,
    latch: activeLatch,
  } satisfies RegistryDeps & { reportPaths: string[]; latch: Latch };
}

function openLatch(latch: Latch) {
  latch.opened = true;
  for (const resolve of latch.waiters.splice(0)) {
    resolve();
  }
}

async function settledRun(deps: RegistryDeps, runID: string) {
  return getRun(deps.storage, runID);
}

describe("registry", () => {
  test("starts a run and returns its id and status", async () => {
    const registry = createRegistry(makeDeps());
    const result = await registry.start(startInput());

    expect(result.runID).toMatch(/^run-/);
    expect(result.status).toBe("awaiting_approval");
    expect(result.tasks).toEqual(["a"]);
  });

  test("approve triggers the driver and finishes the run", async () => {
    const deps = makeDeps();
    const registry = createRegistry(deps);
    const started = await registry.start(startInput());

    const confirm = await registry.approve(started.runID);
    expect(confirm.status).toBe("running");
    await registry.idle();

    const run = await settledRun(deps, started.runID);
    expect(run?.status).toBe("completed");
    expect(run?.costUSD).toBe(0.01);
  });

  test("approve rejects a non-awaiting run", async () => {
    const deps = makeDeps();
    const registry = createRegistry(deps);
    const started = await registry.start(startInput());
    await registry.approve(started.runID);

    expect(await registry.approve(started.runID).catch((error) => error.message)).toMatch(
      /not awaiting approval/,
    );
    await registry.idle();
  });

  test("pausing freezes an active run; resume finishes it", async () => {
    const latch: Latch = { opened: false, waiters: [] };
    const deps = makeDeps(latch);
    const registry = createRegistry(deps);
    const started = await registry.start({ ...startInput(), tasks: [task("a"), task("b")] });
    void registry.approve(started.runID);

    await registry.pause(started.runID);
    const paused = await getRun(deps.storage, started.runID);
    expect(paused?.status).toBe("paused");

    openLatch(latch);
    await registry.idle();

    await registry.resume(started.runID);
    await registry.idle();
    const run = await getRun(deps.storage, started.runID);
    expect(run?.status).toBe("completed");
  });

  test("resume refuses to continue past an exhausted budget", async () => {
    const deps = makeDeps();
    const registry = createRegistry(deps);
    const stored = await createRun(deps.storage, startInput());
    await updateRun(deps.storage, stored.id, (run) => {
      run.status = "paused";
      run.costUSD = run.budgetUSD;
    });

    expect(await registry.resume(stored.id).catch((error) => error.message)).toMatch(/raiseBudgetTo/);
    await registry.resume(stored.id, stored.budgetUSD + 0.5);
    const run = await getRun(deps.storage, stored.id);
    expect(run?.status).toBe("running");
    await registry.idle();
  });

  test("cancel stops future dispatch", async () => {
    const latch: Latch = { opened: false, waiters: [] };
    const deps = makeDeps(latch);
    const registry = createRegistry(deps);
    const started = await registry.start({ ...startInput(), tasks: [task("a"), task("b")] });
    void registry.approve(started.runID);
    await registry.cancel(started.runID);

    openLatch(latch);
    await registry.idle();

    expect(((await registry.status(started.runID)) as RunDetail).status).toBe("cancelled");
    const run = await getRun(deps.storage, started.runID);
    // Cancelled before the driver reserved the slot: nothing was dispatched.
    expect(run?.tasks[0].status).toBe("pending");
  });
  test("replan appends tasks before approval", async () => {
    const deps = makeDeps();
    const registry = createRegistry(deps);
    const started = await registry.start(startInput());

    const replan = await registry.replan(started.runID, [task("zz")]);
    expect(replan.tasks.map((entry) => entry.id)).toEqual(["a", "zz"]);

    await registry.approve(started.runID);
    await registry.idle();
    const run = await getRun(deps.storage, started.runID);
    expect(run?.tasks.every((entry) => entry.status === "passed")).toBe(true);
  });

  test("replan rejects duplicate task ids", async () => {
    const deps = makeDeps();
    const registry = createRegistry(deps);
    const started = await registry.start(startInput());

    expect(
      await registry
        .replan(started.runID, [task("a")])
        .catch((error) => error.message),
    ).toMatch(/already exist/);
  });

  test("status returns run detail", async () => {
    const deps = makeDeps();
    const registry = createRegistry(deps);
    const started = await registry.start(startInput());

    const summary = (await registry.status(started.runID)) as RunDetail;
    expect(summary.runID).toBe(started.runID);
    expect(summary.status).toBe("awaiting_approval");
  });

  test("report writes a static HTML file", async () => {
    const deps = makeDeps();
    const registry = createRegistry(deps);
    const started = await registry.start(startInput());

    const path = await registry.report(started.runID);
    expect(path).toBe("/proj/opencode-orchestrator-report.html");
    expect(deps.reportPaths).toContain(path);
  });

  test("reconcile retains orphaned child sessions and does not duplicate dispatch", async () => {
    const deps = makeDeps();
    const registry = createRegistry(deps);
    const started = await registry.start(startInput());
    await updateRun(deps.storage, started.runID, (run) => {
      run.status = "running";
      run.tasks[0].status = "in_progress";
      run.tasks[0].attempts.push({ model: "m", startedAt: 1, sessionID: "ses_gone" });
    });

    const summary = await registry.reconcile();

    expect(summary.resumed).toEqual([]);
    await registry.idle();
    const run = await getRun(deps.storage, started.runID);
    expect(run?.tasks[0].status).toBe("in_progress");
    expect(run?.events.at(-1)?.kind).toBe("reconciled");
  });

  test("reconcile leaves paused runs alone", async () => {
    const deps = makeDeps();
    const registry = createRegistry(deps);
    const stored = await createRun(deps.storage, startInput());
    await updateRun(deps.storage, stored.id, (run) => {
      run.status = "paused";
      run.tasks[0].status = "in_progress";
    });

    const summary = await registry.reconcile();

    expect(summary.resumed).toEqual([]);
    const run = await getRun(deps.storage, stored.id);
    expect(run?.tasks[0].status).toBe("in_progress");
  });

  test("scope exceptions are recorded", async () => {
    const deps = makeDeps();
    const registry = createRegistry(deps);
    const started = await registry.start(startInput());

    const result = await registry.scopeException(started.runID, "allow repo cleanup", "a");

    expect(result.recorded).toBe("allow repo cleanup");
    const run = await getRun(deps.storage, started.runID);
    expect(run?.events.at(-1)?.kind).toBe("scope_exception");
  });

  test("scope exceptions reject unknown tasks", async () => {
    const deps = makeDeps();
    const registry = createRegistry(deps);
    const started = await registry.start(startInput());

    expect(
      await registry.scopeException(started.runID, "note", "nope").catch((error) => error.message),
    ).toMatch(/no task nope/);
  });
});
