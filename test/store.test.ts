import { describe, expect, test } from "bun:test";
import { MemoryStorage } from "../src/storage/memory.ts";
import { createRun, getRun, updateRun, listRuns } from "../src/store.ts";

function newRunInput() {
  return {
    goal: "Ship the feature",
    budgetUSD: 0.5,
    integrationBranch: "orchestrator/run-1",
    tasks: [
      { id: "t1", title: "Step one", prompt: "Implement one.", dependsOn: [] },
      { id: "t2", title: "Step two", prompt: "Implement two.", dependsOn: ["t1"] },
    ],
  };
}

describe("run store", () => {
  test("creates a validated run in awaiting_approval state", async () => {
    const storage = new MemoryStorage();
    const run = await createRun(storage, newRunInput());

    expect(run.status).toBe("awaiting_approval");
    expect(run.costUSD).toBe(0);
    expect(run.tasks).toHaveLength(2);
    expect(run.tasks[0].status).toBe("pending");
    expect(run.integrationBranch).toBe("orchestrator/run-1");
    expect(run.id).toMatch(/^run-/);

    const stored = await getRun(storage, run.id);
    expect(stored?.tasks).toHaveLength(2);
  });

  test("round-trips through serialization", async () => {
    const storage = new MemoryStorage();
    const created = await createRun(storage, newRunInput());
    await updateRun(storage, created.id, (run) => {
      run.tasks[0].status = "passed";
    });

    const reloaded = await getRun(storage, created.id);
    expect(reloaded?.tasks[0].status).toBe("passed");
  });

  test("lists runs newest first", async () => {
    const storage = new MemoryStorage();
    const a = await createRun(storage, newRunInput());
    const b = await createRun(storage, newRunInput());
    const runs = await listRuns(storage);
    expect(runs.map((run) => run.id)).toEqual([b.id, a.id]);
  });

  test("getRun returns undefined for an unknown id", async () => {
    const storage = new MemoryStorage();
    expect(await getRun(storage, "run-nope")).toBeUndefined();
  });
});
