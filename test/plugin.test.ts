import { describe, expect, test } from "bun:test";
import orchestrator from "../src/plugin/index.ts";

describe("orchestrator plugin", () => {
  test("registers a status tool without starting a session", async () => {
    const hooks = await orchestrator({
      client: {} as never,
      project: {} as never,
      directory: "/workspace",
      worktree: "/workspace",
      experimental_workspace: { register() {} },
      serverUrl: new URL("http://127.0.0.1:4096"),
      $: {} as never,
    });

    expect(hooks.tool?.orchestrator_status).toBeDefined();
    expect(hooks.event).toBeDefined();
  });
});
