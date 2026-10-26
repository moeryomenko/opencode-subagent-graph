import { describe, expect, test } from "bun:test";
import { classifyComplexity, selectPolicyEntry, validateModelPolicy } from "../src/model-policy.ts";

describe("model policy", () => {
  const entries = validateModelPolicy([
    { model: "p/cheap", retry: 2, budget: "cheaper" },
    { model: "p/mid", retry: 1, budget: "medium" },
    { model: "p/high", retry: 2, budget: "expensive" },
  ]);

  test("validates named model entries and retry counts", () => {
    expect(entries[0]).toEqual({ model: "p/cheap", retry: 2, budget: "cheaper" });
    expect(() => validateModelPolicy([{ model: "p/a", retry: 0, budget: "cheaper" }])).toThrow("positive integer");
  });

  test("rejects invalid tiers and duplicate model IDs", () => {
    expect(() => validateModelPolicy([{ model: "p/a", retry: 1, budget: "low" }])).toThrow("budget");
    expect(() => validateModelPolicy([
      { model: "p/a", retry: 1, budget: "cheaper" },
      { model: "p/a", retry: 2, budget: "medium" },
    ])).toThrow("duplicate model");
  });

  test("routes by preferred tier and then escalates by attempt", () => {
    expect(selectPolicyEntry(entries, "cheaper", 0)?.model).toBe("p/cheap");
    expect(selectPolicyEntry(entries, "medium", 0)?.model).toBe("p/mid");
    expect(selectPolicyEntry(entries, "medium", 1)?.model).toBe("p/high");
    expect(selectPolicyEntry(entries, "expensive", 2)).toBeUndefined();
  });

  test("extracts and validates classifier JSON", () => {
    expect(classifyComplexity('analysis ```json\n{"complexity":"simple"}\n```')).toBe("simple");
    expect(classifyComplexity('{"complexity":"invalid"}')).toBeUndefined();
  });

  test("uses the configured classifier model's retry limit", () => {
    expect(selectPolicyEntry(entries, "cheaper", { "p/cheap": 2 })).toEqual(entries[1]);
  });
});
