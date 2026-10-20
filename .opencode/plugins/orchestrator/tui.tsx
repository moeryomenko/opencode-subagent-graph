import { createEffect, createSignal, onCleanup } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui";
import { orchestratorRpc } from "../../../src/plugin/rpc.ts";

interface RunSummary {
  runID: string;
  status: string;
  costUSD: number;
  budgetUSD: number;
  tasksPassed: number;
  tasksTotal: number;
}

function readRuns(value: unknown): RunSummary[] {
  if (typeof value !== "object" || value === null || !("status" in value)) return [];
  const status = value.status;
  if (typeof status !== "object" || status === null || !("runs" in status) || !Array.isArray(status.runs)) return [];
  return status.runs.filter((run): run is RunSummary =>
    typeof run === "object" && run !== null &&
    typeof (run as Record<string, unknown>).runID === "string" &&
    typeof (run as Record<string, unknown>).status === "string" &&
    typeof (run as Record<string, unknown>).costUSD === "number" &&
    typeof (run as Record<string, unknown>).budgetUSD === "number" &&
    typeof (run as Record<string, unknown>).tasksPassed === "number" &&
    typeof (run as Record<string, unknown>).tasksTotal === "number",
  );
}

function OrchestratorPanel(props: { context: Context; sessionID: string }) {
  const [runs, setRuns] = createSignal<RunSummary[]>([]);
  const rpc = props.context.client.rpc(orchestratorRpc);
  let active = true;

  const refresh = async () => {
    const snapshot = await rpc.snapshot({ sessionID: props.sessionID }, { location: props.context.location });
    if (active) setRuns(readRuns(snapshot));
  };
  createEffect(() => {
    void props.sessionID;
    void refresh().catch(() => setRuns([]));
  });
  const timer = setInterval(() => void refresh().catch(() => setRuns([])), 1_000);
  onCleanup(() => {
    active = false;
    clearInterval(timer);
  });

  return (
    <box border={true} borderStyle="rounded" paddingLeft={1} paddingRight={1} marginBottom={1}>
      <text fg="#7dd3fc">Orchestrator</text>
      <text>{runs().length === 0 ? " No active runs for this session." : ""}</text>
      {runs().map((run) => (
        <text>{`${run.runID}: ${run.status} · ${run.tasksPassed}/${run.tasksTotal} tasks · $${run.costUSD.toFixed(4)} / $${run.budgetUSD.toFixed(2)}`}</text>
      ))}
    </box>
  );
}

export default Plugin.define({
  id: "subagent-graph",
  setup(context) {
    return context.ui.slot({
      append: "session.composer.top",
      render: ({ sessionID }) => <OrchestratorPanel context={context} sessionID={sessionID} />,
    });
  },
});
