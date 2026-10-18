import { describe, expect, test } from "bun:test";
import { makeSessionClient, type OpenCodeSessionApi } from "../src/opencode-session.ts";

function fakeSessionDomain() {
  const calls: string[] = [];
  const domain: OpenCodeSessionApi = {
    async create(input) {
      calls.push(`create:${input.title}:${input.agent}:${input.model?.providerID}/${input.model?.id}:${input.location?.directory}`);
      return { id: "ses_1", cost: 0, tokens: { input: 0, output: 0 } };
    },
    async prompt(input) {
      calls.push(`prompt:${input.sessionID}:${input.text.slice(0, 12)}`);
      return {};
    },
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
  return { domain, calls };
}

describe("makeSessionClient", () => {
  test("runs create, prompt, wait, get and maps the outcome", async () => {
    const { domain, calls } = fakeSessionDomain();
    const client = makeSessionClient(domain);

    const handle = await client.run({
      title: "ops/a",
      agent: "engineer",
      model: "anthropic/claude-haiku-4-5",
      directory: "/proj",
      prompt: "Implement task a.",
    });

    expect(handle).toEqual({
      id: "ses_1",
      outcome: "succeeded",
      costUSD: 0.05,
      tokens: { input: 100, output: 200 },
    });
    expect(calls).toEqual([
      "create:ops/a:engineer:anthropic/claude-haiku-4-5:/proj",
      "prompt:ses_1:Implement ta",
      "wait:ses_1",
      "get:ses_1",
    ]);
  });

  test("interrupts a session", async () => {
    const { domain, calls } = fakeSessionDomain();
    const client = makeSessionClient(domain);

    await client.interrupt("ses_9");

    expect(calls).toEqual(["interrupt:ses_9"]);
  });

  test("skips model parsing when the ref has no slash", async () => {
    const { domain, calls } = fakeSessionDomain();
    const client = makeSessionClient(domain);

    await client.run({ title: "t", agent: "engineer", model: "", directory: "/d", prompt: "p" });

    expect(calls[0]).toBe("create:t:engineer:undefined/undefined:/d");
  });

  test("maps missing outcome to failed", async () => {
    const { domain, calls } = fakeSessionDomain();
    domain.get = async () => ({ id: "ses_1", cost: 0, tokens: { input: 0, output: 0 } });
    const client = makeSessionClient(domain);

    const handle = await client.run({ title: "t", agent: "engineer", model: "a/b", directory: "/d", prompt: "p" });

    expect(handle.outcome).toBe("failed");
    expect(handle.costUSD).toBe(0);
    expect(handle.tokens).toEqual({ input: 0, output: 0 });
  });
});
