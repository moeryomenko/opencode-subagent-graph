export interface AssistantUsage {
  sessionID: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface SessionUsageUpdatedEvent {
  type: "session.usage.updated";
  properties: {
    sessionID?: unknown;
    cost?: unknown;
    tokens?: {
      input?: unknown;
      output?: unknown;
      reasoning?: unknown;
      cache?: { read?: unknown; write?: unknown };
    };
  };
}

function isSessionUsageUpdatedEvent(value: unknown): value is SessionUsageUpdatedEvent {
  if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "session.usage.updated") {
    return false;
  }
  return "properties" in value && typeof value.properties === "object" && value.properties !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Parse the V2 aggregate usage event emitted for a session. */
export function completedAssistantUsage(event: unknown): AssistantUsage | undefined {
  if (!isSessionUsageUpdatedEvent(event)) return undefined;

  const { sessionID, cost, tokens } = event.properties;
  const cache = tokens?.cache;
  if (
    typeof sessionID !== "string" ||
    !isNumber(cost) ||
    !isNumber(tokens?.input) ||
    !isNumber(tokens?.output) ||
    !isNumber(tokens?.reasoning) ||
    !isNumber(cache?.read) ||
    !isNumber(cache?.write)
  ) {
    return undefined;
  }

  return {
    sessionID,
    cost,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    reasoningTokens: tokens.reasoning,
    cacheReadTokens: cache.read,
    cacheWriteTokens: cache.write,
  };
}
