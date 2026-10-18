import type { SessionClientLike } from "./scheduler/engine.ts";

/**
 * Loose structural typing of the plugin session domain so tests and the plugin
 * can share this adapter without importing the Effect-typed domain directly.
 */
export interface OpenCodeSessionApi {
  create(input: {
    title?: string | null;
    agent?: string | null;
    model?: { id: string; providerID: string; variant?: string } | null;
    location?: { directory?: string | null } | null;
  }): Promise<{
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
  prompt(input: { sessionID: string; text: string }): Promise<unknown>;
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

function parseModel(model: string): { id: string; providerID: string } | null {
  const separator = model.indexOf("/");
  if (separator < 1) {
    return null;
  }
  return {
    providerID: model.slice(0, separator),
    id: model.slice(separator + 1),
  };
}

/** Engine client that passes interrupt() through for cancellation. */
export interface OrchestratorSessionClient extends SessionClientLike {
  interrupt(sessionID: string): Promise<void>;
}

/** Adapter from the plugin's session domain to the engine's minimal client surface. */
export function makeSessionClient(api: OpenCodeSessionApi): OrchestratorSessionClient {
  return {
    async run(input) {
      const created = await api.create({
        title: input.title,
        agent: input.agent,
        model: parseModel(input.model),
        location: { directory: input.directory },
      });
      const sessionID = created.id;

      await api.prompt({ sessionID, text: input.prompt });
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
