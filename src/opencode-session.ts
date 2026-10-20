import type { SessionClientLike } from "./scheduler/engine.ts";

export interface OpenCodeSessionApi {
  create?(input: {
    title?: string | null;
    agent?: string | null;
    model?: { id: string; providerID: string } | null;
    location?: { directory?: string | null } | null;
  }): Promise<{ id: string }>;
  prompt?(input: { sessionID: string; text: string }): Promise<unknown>;
  wait(input: { sessionID: string }): Promise<void>;
  get(input: { sessionID: string }): Promise<{
    id: string;
    outcome?: "succeeded" | "failed" | "interrupted";
    cost?: number;
    tokens?: {
      input: number;
      output: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  }>;
  interrupt(input: { sessionID: string }): Promise<unknown>;
}

/** The subset of builtin tool context required by the subagent tool. */
export interface SubagentToolContext {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
  signal: AbortSignal;
  progress(update: Record<string, unknown>): Promise<void>;
}

export interface BuiltinSubagentTool {
  execute(
    input: {
      agent: string;
      description: string;
      model: string;
      prompt: string;
      background: boolean;
    },
    context: SubagentToolContext,
  ): Promise<{ output?: unknown }>;
}

export interface SubagentResult {
  sessionID: string;
  status: "running" | "completed";
}

function readSubagentResult(value: unknown): SubagentResult | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const result = value as Record<string, unknown>;
  if (typeof result.sessionID !== "string") return undefined;
  if (result.status !== "running" && result.status !== "completed") return undefined;
  return { sessionID: result.sessionID, status: result.status };
}

/** Engine client that uses the host builtin subagent tool for engineer dispatch. */
export interface OrchestratorSessionClient extends SessionClientLike {
  interrupt(sessionID: string): Promise<void>;
}

/**
 * Dispatches through the builtin `subagent` tool. The parent tool context keeps
 * the host permission and nesting policy intact.
 */
export function makeSessionClient(
  api: OpenCodeSessionApi,
  subagent?: BuiltinSubagentTool,
  parent?: SubagentToolContext,
): OrchestratorSessionClient {
  return {
    async run(input) {
      if (!subagent || !parent) {
        if (!api.create || !api.prompt) {
          throw new Error("builtin subagent dispatch requires a tool and parent context");
        }
        const created = await api.create({
          title: input.title,
          agent: input.agent,
          location: { directory: input.directory },
        });
        await input.onStarted?.(created.id);
        await api.prompt({ sessionID: created.id, text: input.prompt });
        await api.wait({ sessionID: created.id });
        const info = await api.get({ sessionID: created.id });
        return {
          id: created.id,
          outcome: info.outcome ?? "failed",
          costUSD: info.cost ?? 0,
          tokens: { input: info.tokens?.input ?? 0, output: info.tokens?.output ?? 0 },
        };
      }

      let sessionID: string | undefined;
      const reportStarted = async (candidate: string) => {
        if (sessionID || candidate.length === 0) return;
        sessionID = candidate;
        await input.onStarted?.(candidate);
      };
      const dispatchContext: SubagentToolContext = {
        ...parent,
        progress: async (update) => {
          const child = typeof update.sessionID === "string" ? update.sessionID : undefined;
          if (child) await reportStarted(child);
          /*
           * Background child progress can arrive after the parent tool call
           * has returned. OpenCode rejects a progress update in that window,
           * which would fail an otherwise healthy child. Progress is only
           * cosmetic here, so never let it abort the dispatch.
           */
          try {
            await parent.progress(update);
          } catch {
            /* Parent call is no longer running; the child remains valid. */
          }
        },
      };

      const result = await subagent.execute(
        {
          agent: input.agent,
          description: input.title,
          model: input.model,
          prompt: input.prompt,
          background: true,
        },
        dispatchContext,
      );
      const dispatched = readSubagentResult(result.output);
      if (dispatched) await reportStarted(dispatched.sessionID);
      if (!sessionID) {
        throw new Error("builtin subagent tool did not return a child session ID");
      }

      await api.wait({ sessionID });
      const info = await api.get({ sessionID });
      return {
        id: sessionID,
        outcome: info.outcome ?? "failed",
        costUSD: info.cost ?? 0,
        tokens: {
          input: info.tokens?.input ?? 0,
          output: info.tokens?.output ?? 0,
        },
      };
    },
    async interrupt(sessionID) {
      await api.interrupt({ sessionID });
    },
  };
}
