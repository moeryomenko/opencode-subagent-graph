export interface AssistantUsage {
  messageID: string;
  sessionID: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface MessageUpdatedEvent {
  type: "message.updated";
  properties: {
    info: {
      id?: unknown;
      role?: unknown;
      sessionID?: unknown;
      time?: { completed?: unknown };
      cost?: unknown;
      tokens?: {
        input?: unknown;
        output?: unknown;
        reasoning?: unknown;
        cache?: { read?: unknown; write?: unknown };
      };
    };
  };
}

function isMessageUpdatedEvent(value: unknown): value is MessageUpdatedEvent {
  if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "message.updated") {
    return false;
  }

  if (!("properties" in value) || typeof value.properties !== "object" || value.properties === null) {
    return false;
  }

  return "info" in value.properties && typeof value.properties.info === "object" && value.properties.info !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function completedAssistantUsage(event: unknown): AssistantUsage | undefined {
  if (!isMessageUpdatedEvent(event)) return undefined;

  const info = event.properties.info;
  const tokens = info.tokens;
  const cache = tokens?.cache;

  if (
    info.role !== "assistant" ||
    typeof info.id !== "string" ||
    typeof info.sessionID !== "string" ||
    info.time?.completed === undefined ||
    !isNumber(info.cost) ||
    !isNumber(tokens?.input) ||
    !isNumber(tokens?.output) ||
    !isNumber(tokens?.reasoning) ||
    !isNumber(cache?.read) ||
    !isNumber(cache?.write)
  ) {
    return undefined;
  }

  return {
    messageID: info.id,
    sessionID: info.sessionID,
    cost: info.cost,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    reasoningTokens: tokens.reasoning,
    cacheReadTokens: cache.read,
    cacheWriteTokens: cache.write,
  };
}
