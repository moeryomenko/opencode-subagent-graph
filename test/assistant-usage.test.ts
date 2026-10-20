import { describe, expect, test } from "bun:test";
import { completedAssistantUsage } from "../src/runtime/assistant-usage.ts";

describe("completedAssistantUsage", () => {
  test("returns cost and tokens from a V2 session usage event", () => {
    const usage = completedAssistantUsage({
      type: "session.usage.updated",
      properties: {
        sessionID: "session-1",
        cost: 0.02,
        tokens: {
          input: 10,
          output: 20,
          reasoning: 3,
          cache: { read: 4, write: 5 },
        },
      },
    });

    expect(usage).toEqual({
      sessionID: "session-1",
      cost: 0.02,
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 5,
    });
  });

  test("ignores a V1 message event", () => {
    expect(completedAssistantUsage({ type: "message.updated", properties: {} })).toBeUndefined();
  });

  test("ignores an incomplete usage event", () => {
    expect(
      completedAssistantUsage({
        type: "session.usage.updated",
        properties: { sessionID: "session-1", cost: 0.02, tokens: { input: 1 } },
      }),
    ).toBeUndefined();
  });
});
