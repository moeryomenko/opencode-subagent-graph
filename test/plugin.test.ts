import { describe, expect, test } from "bun:test";
import orchestrator from "../src/plugin/index.ts";

describe("orchestrator plugin", () => {
  test("defines the V2 plugin identity", () => {
    expect(orchestrator.id).toBe("subagent-graph");
    expect(typeof orchestrator.setup).toBe("function");
  });
});
