import { describe, expect, test } from "bun:test";
import { completedAssistantUsage } from "../src/runtime/assistant-usage.ts";

describe("completedAssistantUsage", () => {
  test("returns cost and tokens from a completed assistant update", () => {
    const usage = completedAssistantUsage({
      type: "message.updated",
      properties: {
        info: {
          id: "message-1",
          role: "assistant",
          sessionID: "session-1",
          time: { created: 1, completed: 2 },
          cost: 0.02,
          tokens: {
            input: 10,
            output: 20,
            reasoning: 3,
            cache: { read: 4, write: 5 },
          },
        },
      },
    });

    expect(usage).toEqual({
      messageID: "message-1",
      sessionID: "session-1",
      cost: 0.02,
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 5,
    });
  });

  test("ignores an assistant update with no message info", () => {
    expect(completedAssistantUsage({ type: "message.updated", properties: {} })).toBeUndefined();
  });

  test("ignores an assistant update before completion", () => {
    expect(
      completedAssistantUsage({
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            time: { created: 1 },
          },
        },
      }),
    ).toBeUndefined();
  });
});
