> Part of the [Agent Softhouse Orchestrator case study](README.md) — problem and thesis

## 2. The problem

Running AI agents as a team has a predictable failure pattern:

- **Rules in prompts get ignored.** "Never push to production" is a suggestion, not a barrier.
- **Self-approval.** The agent that wrote the code also declares it "tested and working".
- **Declared evidence.** An agent says "all tests pass" without having run them.
- **Runaway cost.** Revision loops with no cap, with a large context re-read on every turn.
- **No audit trail.** It is hard to answer "who approved this and based on what?".
- **Blast radius.** An agent with a shell and a repo is a code-execution surface on your own machine.

The original framework described the right process. What was missing was something that made the process *non-optional*.

---

## 3. The thesis

> The agent prompt is the weakest layer. The real barriers are code, CLI permissions, an isolated worktree and a minimal environment.

Three design rules follow:

1. **The graph decides, the agent proposes.** An agent returns structured output (validated by zod). The router, not the agent, picks the next node.
2. **Evidence is computed, not declared.** Commit existence, a clean tree, allowed paths and `npm test` are checked by the host code at several points. The agent's claim counts for nothing.
3. **Fail closed.** Any error, timeout, invalid output or turn limit becomes an escalation to the human. The system never "continues anyway".

Why a graph? A software delivery process is already a state machine with loops (revision cycles), branches (clear vs. ambiguous requests), human pauses and terminal states. LangGraph models that directly, gives a checkpointer for pause/resume, and makes the flow *visible* (the README diagram is generated from the real graph).


