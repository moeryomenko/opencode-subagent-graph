export interface EngineerModel {
  providerID: string;
  modelID: string;
}

export interface EngineerSessionInput {
  client: LegacySessionClient;
  worktree: string;
  title: string;
  agent: string;
  model: EngineerModel;
  prompt: string;
}

interface SessionCreateResult {
  data?: {
    id: string;
  };
}

export interface LegacySessionClient {
  session: {
    create(input: {
      query: { directory: string };
      body: { title: string };
    }): Promise<SessionCreateResult>;
    promptAsync(input: {
      path: { id: string };
      query: { directory: string };
      body: {
        agent: string;
        model: EngineerModel;
        parts: Array<{ type: "text"; text: string }>;
      };
    }): Promise<unknown>;
  };
}

export async function createEngineerSession(input: EngineerSessionInput): Promise<string> {
  const created = await input.client.session.create({
    query: { directory: input.worktree },
    body: { title: input.title },
  });

  if (!created.data) {
    throw new Error("OpenCode did not return an engineer session.");
  }

  await input.client.session.promptAsync({
    path: { id: created.data.id },
    query: { directory: input.worktree },
    body: {
      agent: input.agent,
      model: input.model,
      parts: [{ type: "text", text: input.prompt }],
    },
  });

  return created.data.id;
}
