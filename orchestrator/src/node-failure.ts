import type { Usage } from "./run-agent.ts";

// `usage` is set when the CLI reported what a failed run spent (e.g. max_turns), so the budget still counts it.
export class NodeFailure extends Error {
  usage?: Usage;
}
