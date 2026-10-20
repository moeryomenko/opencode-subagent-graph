export const orchestratorRpc = {
  id: "subagent-graph",
  methods: {
    snapshot: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
      },
      output: {
        type: "object",
        properties: { status: {} },
        required: ["status"],
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
      },
    },
  },
} as const;
