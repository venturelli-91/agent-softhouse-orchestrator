> Part of the [Agent Softhouse Orchestrator case study](README.md) — lessons, decisions and limits

## 14. Bugs and lessons learned

A selection of real bugs, because they say more than the happy path:

| Bug | Root cause | Fix |
|---|---|---|
| Dev could not write in its own worktree | A `deny Write(~/**)` matched the worktree because the Windows temp dir lives inside the user's home (deny always wins) | Removed the broad deny; scope with `Write(./**)` |
| Dev couldn't commit on Windows | `claude -p` exposes `PowerShell`, not `Bash` | Shell tool chosen per platform |
| Git rejected the null device | `os.devNull` on Windows is `\\.\nul` | Use `NUL` / `/dev/null` explicitly |
| A verbose-but-approving QA killed the node | zod `refine` rejected a summary over 10 lines, wasting a round | Truncate in code; the node no longer fails on length |
| Stale `.env` after the English rename | Old variable names silently ignored | Documented: regenerate from `.env.example`; missing vars are errors (fail closed) |
| `gh pr merge` merged but "failed" | Local branch cleanup error was reported as a merge failure | Merge runs outside the local repo and the result is read independently |
| 5-ticket limit hit by leftovers | Old worktrees counted as active | `orch clean` removes finished worktrees, branch and state (`--remote` too) |
| Deploy "shadow binary" bypass | A binary in the cwd could shadow the intended command (PATHEXT / `cmd.exe` cwd lookup) | Case-insensitive shadow check that follows the live PATHEXT |

**Lessons**

1. If a rule matters, it must be a line of code with a test, not a sentence in a prompt.
2. A cheaper model can look equal on a benchmark and still be more expensive in the pipeline (triage on Haiku).
3. An eval that saturates at 100% tells you about the eval, not about the model.
4. When all models fail the same way, suspect the harness or the prompt before the models.
5. Treat every agent-touched artifact (diff, config, brief, postmortem) as untrusted input when it crosses back to the host.

---

## 15. Key decisions and trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| LangGraph.js over a hand-rolled state machine | Native `interrupt()`, checkpointing, a generated diagram | Dependency on the library's API |
| Agents as `claude -p` subprocesses | Reuses the Claude Code login (no API key to manage), strong per-call permission flags | Subprocess overhead; permission semantics are CLI-defined |
| One prompt source (see §4) | No prompt drift between interactive and orchestrated use | Interactive subagents read their prompt through a pointer |
| JSON-file checkpointer | Avoids a native module (`better-sqlite3`) | Rewrites the whole file per checkpoint; fine for a few local tickets |
| No database for tickets | State is the graph's own plus git worktrees | Not multi-user |
| Static QA (no shell) | Smaller attack surface; evidence comes from the graph | QA can't exercise a UI; revisit for frontend tickets |
| Deploy commands from external config only | They run with the human's credentials | Slightly more setup per repo |
| Operations as modules, not a graph | A monitor loop doesn't need pause/resume semantics | Two mental models (graph + modules) |
| Hotfixes respect the 5-ticket cap | An incident storm must not become a resource storm | An incident can wait at the limit |

**Deliberately not built:** a DeepSeek/direct-LangChain executor (only the registry hook), a container sandbox for `npm test`, a knowledge-manager node on every ticket, QA with a browser (browser checks are the code-only `webcheck` node instead), and Fable-tier models on any stage (billed in dollars, and no stage showed a failure a stronger model would fix).

---

## 16. Honest limitations

- Built for **individual, local use**, not as a multi-tenant service.
- Validated on **a handful of real tickets** in a throwaway repo; not a production-scale benchmark.
- The **command deploy target and HTTP probe were validated once, on a local staging service** (one cycle, no hosted environment, no real credentials; see `playbooks/2026-11-04-orchestrator-decisions.md`); a hosted staging run is still the next validation.
- `npm test` still runs **on the host**; the full mitigation is a container/OS sandbox.
- The JSON checkpointer rewrites on each checkpoint.
- Dev evals saturate; planner-criteria *quality* is not measured.

Listing these is deliberate: the project's premise is that claims need evidence.


