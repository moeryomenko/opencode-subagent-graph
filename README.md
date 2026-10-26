# opencode-subagent-graph

An OpenCode plugin that turns a goal into a DAG of subtasks, runs engineer
subagent sessions per task with retries and model escalation, tracks cost
against a budget, and reports results.

Requires OpenCode V2 (>= 2.0.32) with the `@opencode/plugin` (V2) API.

## Install

1. Install the dependency:

   ```sh
   bun install
   ```

2. Register the plugin directory in the project `opencode.jsonc` (already done):

   ```jsonc
   { "plugins": ["./.opencode/plugins/orchestrator"] }
   ```

3. Keep the builtin role definitions in `.opencode/agent/`; tasks default to
   `engineer` and may select `researcher`, `explorer`, or `classifier`.

### Model policy

Pass plugin options in the global or project `opencode.json(c)` configuration.
OpenCode applies project options over global options. The project `models` list
replaces the global list:

```jsonc
{
  "plugins": [{
    "package": "./.opencode/plugins/orchestrator",
    "options": {
      "models": [
        { "model": "provider/model", "retry": 2, "budget": "cheaper" },
        { "model": "provider/medium", "retry": 1, "budget": "medium" },
        { "model": "provider/expensive", "retry": 1, "budget": "expensive" }
      ]
    }
  }]
}
```

`retry` is the total number of attempts for that model and must be positive.
Simple tasks start on `cheaper`; medium and complex tasks start on `medium`.
Failures escalate to the next available tier, so expensive models are used
only after a failed attempt. Explicit task models bypass automatic routing.
Without a policy, the legacy `modelChain` behavior remains available.

## Tools

All tools are exposed to the model in the `orchestrator` namespace.

| Tool | Purpose |
| --- | --- |
| `orchestrator_start` | Create a run from a task graph (goal, tasks, budget in USD, integration branch, escalation chain). |
| `orchestrator_approve` | Approve a graph and start execution. |
| `orchestrator_status` | Show one run or summarize all runs. |
| `orchestrator_pause` | Interrupt in-progress sessions and requeue their tasks. |
| `orchestrator_resume` | Resume a paused run; optionally raise its budget (`raiseBudgetTo`). |
| `orchestrator_cancel` | Cancel a run; nothing else is dispatched afterwards. |
| `orchestrator_scope_exception` | Record a user-approved exception to task scope. |
| `orchestrator_replan` | Append tasks to a run that is awaiting approval or running. |
| `orchestrator_report` | Write a static HTML report and return its path. |

## Behavior

- `orchestrator_start` validates the task graph: unique ids, known
  dependencies, no cycles, non-empty title and prompt, at most 64 tasks.
- Runs start in `awaiting_approval`; orchestrator_approve starts the scheduler.
- The scheduler dispatches ready tasks (dependencies passed) in parallel
  batches up to `maxParallel`, escalates through `modelChain` on failure, and
  stops at `maxAttempts`.
- Every attempt records the model, session id, outcome, cost, and tokens.
- Spent cost is accumulated per attempt; when it reaches the deposit the run
  pauses with a `budget_stopped` event. `orchestrator_resume` with
  `raiseBudgetTo` continues it.
- Failed tasks block their dependents (`task_blocked`).
- On plugin restart, orphaned in-progress tasks are requeued and running runs
  resume automatically (reconcile at setup).
- Tasks with `model` use it for the first attempt; later attempts fall through
  `modelChain`.
- Task `role` defaults to `engineer`; use `researcher`, `explorer`, or
  `classifier` to select the corresponding builtin OpenCode agent.

## Development

```sh
bun test          # unit tests (fake storage and fake sessions)
bun run typecheck # strict TypeScript
```

Layout:

- `src/plan.ts` — task graph validation and readiness.
- `src/types.ts` — plan, task, attempt, and run state.
- `src/store.ts` — flash-free run persistence with per-run update locks.
- `src/scheduler/engine.ts` — dependency-ordered execution, retries, budget.
- `src/opencode-session.ts` — plugin session domain to engine client adapter.
- `src/plugin/registry.ts` — run lifecycle operations (start/approve/pause/…).
- `src/plugin/index.ts` — `Plugin.define` and tool registration.
