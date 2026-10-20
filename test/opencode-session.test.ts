import { describe, expect, test } from "bun:test";
import {
  makeSessionClient,
  type BuiltinSubagentTool,
  type OpenCodeSessionApi,
  type SubagentToolContext,
} from "../src/opencode-session.ts";

function fakeSessionDomain() {
  const calls: string[] = [];
  const domain: OpenCodeSessionApi = {
    async wait(input) {
      calls.push(`wait:${input.sessionID}`);
    },
    async get(input) {
      calls.push(`get:${input.sessionID}`);
      return {
        id: input.sessionID,
        outcome: "succeeded",
        cost: 0.05,
        tokens: { input: 100, output: 200, reasoning: 10, cache: { read: 5, write: 7 } },
      };
    },
    async interrupt(input) {
      calls.push(`interrupt:${input.sessionID}`);
      return {};
    },
  };
  const tool: BuiltinSubagentTool = {
    async execute(input, context) {
      calls.push(`subagent:${input.agent}:${input.model}:${input.background}:${input.description}`);
      await context.progress({ sessionID: "ses_1", status: "running" });
      return { output: { sessionID: "ses_1", status: "running" } };
    },
  };
  const parent: SubagentToolContext = {
    sessionID: "parent-1",
    agent: "build",
    messageID: "msg-1",
    id: "tool-1",
    signal: AbortSignal.timeout(1000),
    async progress() {},
  };
  return { domain, tool, parent, calls };
}

describe("makeSessionClient", () => {
  test("dispatches through the builtin subagent tool and maps the outcome", async () => {
    const { domain, tool, parent, calls } = fakeSessionDomain();
    const client = makeSessionClient(domain, tool, parent);
    const started: string[] = [];

    const handle = await client.run({
      title: "ops/a",
      agent: "engineer",
      model: "anthropic/claude-haiku-4-5",
      directory: "/proj",
      prompt: "Implement task a.",
      onStarted: async (sessionID) => {
        started.push(sessionID);
      },
    });

    expect(handle).toEqual({
      id: "ses_1",
      outcome: "succeeded",
      costUSD: 0.05,
      tokens: { input: 100, output: 200 },
    });
    expect(started).toEqual(["ses_1"]);
    expect(calls).toEqual([
      "subagent:engineer:anthropic/claude-haiku-4-5:true:ops/a",
      "wait:ses_1",
      "get:ses_1",
    ]);
  });

  test("rejects a builtin tool result without a child session", async () => {
    const { domain, parent } = fakeSessionDomain();
    const tool: BuiltinSubagentTool = { async execute() { return { output: {} }; } };
    const client = makeSessionClient(domain, tool, parent);

    await expect(client.run({ title: "t", agent: "engineer", model: "a/b", directory: "/d", prompt: "p" }))
      .rejects.toThrow("did not return a child session ID");
  });

  test("interrupts a child session", async () => {
    const { domain, tool, parent, calls } = fakeSessionDomain();
    const client = makeSessionClient(domain, tool, parent);

    await client.interrupt("ses_9");

    expect(calls).toEqual(["interrupt:ses_9"]);
  });
});
