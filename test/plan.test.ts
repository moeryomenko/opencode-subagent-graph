import { describe, expect, test } from "bun:test";
import { validatePlan } from "../src/plan.ts";

const independentTasks = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `t${index + 1}`,
    title: `Do step ${index + 1}`,
    prompt: `Implement step ${index + 1}.`,
    dependsOn: [] as string[],
  }));

describe("validatePlan", () => {
  test("accepts a DAG without dependencies", () => {
    const ordered = validatePlan({ tasks: independentTasks(3) });
    expect(ordered).toEqual(["t1", "t2", "t3"]);
  });

  test("respects declared dependencies in topological order", () => {
    const ordered = validatePlan({
      tasks: [
        { id: "integrate", title: "Integrate work", prompt: "Integrate.", dependsOn: ["t2", "t1"] },
        ...independentTasks(2),
      ],
    });
    expect(ordered.indexOf("t1")).toBeLessThan(ordered.indexOf("integrate"));
    expect(ordered.indexOf("t2")).toBeLessThan(ordered.indexOf("integrate"));
  });

  test("rejects a duplicate task id", () => {
    expect(() =>
      validatePlan({
        tasks: [
          { id: "t1", title: "Step one", prompt: "x", dependsOn: [] },
          { id: "t1", title: "Step two", prompt: "y", dependsOn: [] },
        ],
      }),
    ).toThrow(/duplicate task id/);
  });

  test("rejects an unknown dependency", () => {
    expect(() =>
      validatePlan({
        tasks: [{ id: "t1", title: "Step one", prompt: "x", dependsOn: ["missing"] }],
      }),
    ).toThrow(/unknown dependency/);
  });

  test("rejects a dependency cycle", () => {
    expect(() =>
      validatePlan({
        tasks: [
          { id: "t1", title: "Step one", prompt: "x", dependsOn: ["t2"] },
          { id: "t2", title: "Step two", prompt: "y", dependsOn: ["t1"] },
        ],
      }),
    ).toThrow(/dependency cycle/);
  });

  test("rejects an empty prompt or title", () => {
    expect(() =>
      validatePlan({
        tasks: [{ id: "t1", title: "  ", prompt: "x", dependsOn: [] }],
      }),
    ).toThrow(/empty title/);
    expect(() =>
      validatePlan({
        tasks: [{ id: "t1", title: "Step one", prompt: " ", dependsOn: [] }],
      }),
    ).toThrow(/empty prompt/);
  });

  test("rejects an empty task list", () => {
    expect(() => validatePlan({ tasks: [] })).toThrow(/empty task list/);
  });

  test("accepts a model per task", () => {
    const ordered = validatePlan({
      tasks: [
        { id: "t1", title: "Step one", prompt: "x", dependsOn: [], model: "opencode/grok-code" },
      ],
    });
    expect(ordered).toEqual(["t1"]);
  });
});
