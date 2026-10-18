import { tool, type Plugin } from "@opencode-ai/plugin";
import { completedAssistantUsage } from "../runtime/assistant-usage.ts";

const orchestratorStatus = tool({
  description: "Show the status of an orchestrator run.",
  args: {
    runID: tool.schema.string().min(1),
  },
  async execute({ runID }) {
    return {
      title: "Orchestrator status",
      output: `Run ${runID} does not exist.`,
    };
  },
});

const plugin: Plugin = async () => ({
  tool: {
    orchestrator_status: orchestratorStatus,
  },
  async event({ event }) {
    completedAssistantUsage(event);
  },
});

export default plugin;
