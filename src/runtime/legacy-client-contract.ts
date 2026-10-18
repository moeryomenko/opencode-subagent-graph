import type { PluginInput } from "@opencode-ai/plugin";
import type { LegacySessionClient } from "./legacy-client.ts";

declare const client: PluginInput["client"];

const legacySessionClient: LegacySessionClient = client;

void legacySessionClient;
