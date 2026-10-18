import { afterEach, describe, expect, test } from "bun:test";
import { MemoryStorage, type StorageLike } from "../src/storage/memory.ts";
import { createRun } from "../src/store.ts";
import { driveRun, type SessionClientLike, type SessionHandle } from "../src/scheduler/engine.ts";

const task = (id: string, deps: string[] = [], model?: string) => ({
  id,
  title: `Task ${id}`,
  prompt: `Implement ${id}.`,
  dependsOn: deps,
  ...(model !== undefined ? { model } : {}),
});

const newRun = {
  goal: "Ship it",
  budgetUSD: 1,
  integrationBranch: "orch/run",
  tasks: [task("a")],
};

function sequentialClient(script: Array<Partial<SessionHandle>>) {
  let index = 0;
  const calls: string[] = [];
  const client: SessionClientLike = {
    async run(input) {
      calls.push(`${input.model ?? "default"}`);
      const handle = script[Math.min(index++, script.length - 1)];
      return {
        id: `session-${index}`,
        outcome: "succeeded" as const,
        costUSD: 0.01,
        tokens: { input: 10, output: 10 },
        ...handle,
      } satisfies SessionHandle;
    },
  };
  return { client, calls };
}

describe("driveRun", () => {
  let storage: StorageLike;

  afterEach(() => {
    storage = new MemoryStorage();
  });

  test("completes a single task and the run", async () => {
    storage = new MemoryStorage();
    const created = await createRun(storage, newRun);
    const { client, calls } = sequentialClient([]);

    await driveRun(storage, created.id, client, { workdir: "/proj", modelChain: ["m1"] });

    const run = await import("../src/store.ts").then((m) => m.getRun(storage, created.id));
    expect(run?.status).toBe("completed");
    expect(run?.tasks[0].status).toBe("passed");
    expect(run?.costUSD).toBe(0.01);
    expect(calls).toEqual(["m1"]);
  });

  test("escalates to the next model on failure", async () => {
    storage = new MemoryStorage();
    const created = await createRun(storage, newRun);
    const { client, calls } = sequentialClient([{ outcome: "failed" }, {}]);

    await driveRun(storage, created.id, client, {
      workdir: "/proj",
      modelChain: ["m1", "m2"],
      maxAttempts: 2,
    });

    const run = await import("../src/store.ts").then((m) => m.getRun(storage, created.id));
    expect(run?.tasks[0].attempts).toHaveLength(2);
    expect(run?.tasks[0].status).toBe("passed");
    expect(run?.costUSD).toBe(0.02);
    expect(calls).toEqual(["m1", "m2"]);
  });

  test("fails a task after exhausting attempts", async () => {
    storage = new MemoryStorage();
    const created = await createRun(storage, { ...newRun, budgetUSD: 5 });
    const { client, calls } = sequentialClient([{ outcome: "failed" }]);

    await driveRun(storage, created.id, client, {
      workdir: "/proj",
      modelChain: ["m1", "m2"],
      maxAttempts: 2,
    });

    const run = await import("../src/store.ts").then((m) => m.getRun(storage, created.id));
    expect(run?.tasks[0].status).toBe("failed");
    expect(run?.status).toBe("completed");
    expect(calls).toHaveLength(2);
  });

  test("honors per-task model before the chain", async () => {
    storage = new MemoryStorage();
    const created = await createRun(storage, { ...newRun, tasks: [task("a", [], "custom/one")] });
    const { client, calls } = sequentialClient([]);

    await driveRun(storage, created.id, client, { workdir: "/proj", modelChain: ["m1"] });

    const run = await import("../src/store.ts").then((m) => m.getRun(storage, created.id));
    expect(run?.status).toBe("completed");
    expect(calls).toEqual(["custom/one"]);
  });

  test("runs tasks in dependency order", async () => {
    storage = new MemoryStorage();
    const created = await createRun(storage, { ...newRun, tasks: [task("b", ["a"]), task("a")] });
    const { client, calls } = sequentialClient([]);

    await driveRun(storage, created.id, client, { workdir: "/proj", modelChain: ["m1"] });

    const run = await import("../src/store.ts").then((m) => m.getRun(storage, created.id));
    expect(run?.status).toBe("completed");
    expect(calls).toHaveLength(2);
    expect(run?.tasks.every((t) => t.status === "passed")).toBe(true);
  });

  test("pauses the run when the budget is exhausted", async () => {
    storage = new MemoryStorage();
    const created = await createRun(storage, {
      ...newRun,
      budgetUSD: 0.015,
      tasks: [task("a"), task("b")],
    });
    const { client, calls } = sequentialClient([]);

    await driveRun(storage, created.id, client, {
      workdir: "/proj",
      modelChain: ["m1"],
      maxParallel: 1,
    });

    const run = await import("../src/store.ts").then((m) => m.getRun(storage, created.id));
    expect(run?.status).toBe("paused");
    expect(calls).toHaveLength(2);
    expect(run?.events.at(-1)?.kind).toBe("budget_stopped");
  });

  test("does not dispatch while paused and completes after resume", async () => {
    storage = new MemoryStorage();
    const created = await createRun(storage, { ...newRun, tasks: [task("a"), task("b")] });
    const store = await import("../src/store.ts");
    const { client, calls } = sequentialClient([]);

    await store.updateRun(storage, created.id, (run) => {
      run.status = "paused";
    });
    await driveRun(storage, created.id, client, { workdir: "/proj", modelChain: ["m1"] });
    expect(calls).toHaveLength(0);

    await store.updateRun(storage, created.id, (run) => {
      run.status = "running";
    });
    await driveRun(storage, created.id, client, { workdir: "/proj", modelChain: ["m1"] });
    expect(calls).toHaveLength(2);

    const run = await store.getRun(storage, created.id);
    expect(run?.status).toBe("completed");
  });

  test("respects maxParallel within a batch", async () => {
    storage = new MemoryStorage();
    const created = await createRun(storage, { ...newRun, tasks: [task("a"), task("b"), task("c")] });
    let concurrent = 0;
    let peak = 0;
    const client: SessionClientLike = {
      async run() {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent--;
        return { id: "s", outcome: "succeeded", costUSD: 0.01, tokens: { input: 1, output: 1 } };
      },
    };

    await driveRun(storage, created.id, client, { workdir: "/proj", modelChain: ["m1"], maxParallel: 2 });

    expect(peak).toBe(2);
    const run = await import("../src/store.ts").then((m) => m.getRun(storage, created.id));
    expect(run?.status).toBe("completed");
  });
});
