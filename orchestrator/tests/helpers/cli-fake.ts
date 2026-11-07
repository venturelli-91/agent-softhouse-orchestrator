// Preloaded with `node --import` into the orch CLI process: a fake executor and publisher, so the CLI runs the real graph with no model.
import { registerPublisher } from "../../src/publish.ts";
import { NodeFailure, registerExecutor, type Req } from "../../src/run-agent.ts";
import { defaults } from "./fakes.ts";

registerPublisher("fake-cli", {
  publish: (p) => `pr:https://example/pull/${p.id}`,
  merge: async (m) => `merged:${m.pr}`,
});

registerExecutor("fake-cli", {
  async run<T>(req: Req<T>) {
    const output = req.schema.safeParse(defaults[req.role]!(req as Req<unknown>));
    if (!output.success) throw new NodeFailure(`${req.role}: invalid output`);
    return { output: output.data, usage: { tokens_in: 10, tokens_out: 0, cache_read: 0, cache_create: 0, cost_usd: 0, turns: 1, ms: 1 } };
  },
});
