import { describe, expect, test } from "bun:test";
import { createEngineerSession } from "../src/runtime/legacy-client.ts";

describe("createEngineerSession", () => {
  test("creates and prompts a session in the task worktree", async () => {
    const calls: unknown[] = [];
    const client = {
      session: {
        async create(input: unknown) {
          calls.push(input);
          return { data: { id: "session-1" } };
        },
        async promptAsync(input: unknown) {
          calls.push(input);
          return { data: {} };
        },
      },
    };

    const sessionID = await createEngineerSession({
      client,
      worktree: "/workspace/.worktrees/task-1",
      title: "Task task-1",
      agent: "engineer",
      model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
      prompt: "Implement task-1.",
    });

    expect(sessionID).toBe("session-1");
    expect(calls).toEqual([
      {
        query: { directory: "/workspace/.worktrees/task-1" },
        body: { title: "Task task-1" },
      },
      {
        path: { id: "session-1" },
        query: { directory: "/workspace/.worktrees/task-1" },
        body: {
          agent: "engineer",
          model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
          parts: [{ type: "text", text: "Implement task-1." }],
        },
      },
    ]);
  });
});
