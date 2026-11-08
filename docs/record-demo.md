# Record the terminal demo

Recipe for a 60-90 s GIF of one real run. The GIF does not exist yet; this is how to make it.
A run calls the model: expect about US$0.23 and about 90 s for the trivial ticket below (one sample, see [`docs/evidence/cost-1/`](evidence/cost-1/)).

Needs Node 24+, the Claude Code CLI logged in, `orchestrator/.env` (from `.env.example`), `npm ci` in `orchestrator/`,
and a recorder: [`vhs`](https://github.com/charmbracelet/vhs) (below) or `asciinema` plus `agg`.

## 1. Build the throwaway repo (no model, no cost)

Run from `orchestrator/`, in the shell you will record from (bash):

```bash
export ORCH_HOME=$(mktemp -d) ORCH_WORK=$(mktemp -d) DEMO=$(mktemp -d)
node -e '
const { createFixture, git } = await import("./scripts/fixture.ts");
const fs = await import("node:fs");
const repo = createFixture(process.argv[1]);
const t = repo + "/test/checkout.test.js";
fs.writeFileSync(t, fs.readFileSync(t, "utf8").replace(">Submit order<", ">Submit<"));
fs.writeFileSync(repo + "/.orchestrator.json", JSON.stringify({ test: "npm test", merge: "local", publisher: "none" }));
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "green base");
' "$DEMO"
```

[`createFixture`](../orchestrator/scripts/fixture.ts) makes `$DEMO/fixture` with a button and a test that starts red.
The edit changes the test regex to `>Submit<` so the base is green, and commits `.orchestrator.json`.
The base must be green: `orch run` tests a fresh worktree first and refuses a red base with
`base is red before any agent ran (no tokens spent)` ([`flow.ts`](../orchestrator/scripts/orch/flow.ts)).

## 2. The commands to show

```bash
node --env-file=.env scripts/orch.ts run "Rename checkout button label to 'Submit order'" --repo "$DEMO/fixture" --id DEMO-1
node --env-file=.env scripts/orch.ts status
node --env-file=.env scripts/orch.ts approve DEMO-1
node --env-file=.env scripts/orch.ts clean DEMO-1
```

`run` stops at the approval request, `approve` ends with `DEMO-1: simulated_deploy`, `clean` removes worktree, branch and state.
Cost per node lands in `$ORCH_HOME/metrics.jsonl`.

## 3. Record with vhs

Save as `demo.tape` in the repo root (not committed):

```text
Output docs/assets/demo.gif
Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 700
Type "cd orchestrator" Enter
Type `node --env-file=.env scripts/orch.ts run "Rename checkout button label to 'Submit order'" --repo "$DEMO/fixture" --id DEMO-1` Enter
Wait+Screen@180s /TOTAL DEMO-1 status=approval/
Type "node --env-file=.env scripts/orch.ts status" Enter
Sleep 3s
Type "node --env-file=.env scripts/orch.ts approve DEMO-1" Enter
Wait+Screen@60s /simulated_deploy/
Type "node --env-file=.env scripts/orch.ts clean DEMO-1" Enter
Sleep 3s
```

Run `vhs demo.tape` from the repo root, in the shell from step 1 (it inherits `ORCH_HOME`, `ORCH_WORK`, `DEMO`).
The ~90 s model wait is long for a GIF: speed it up in post, or use `asciinema rec` then `agg demo.cast docs/assets/demo.gif`.

## 4. Place and embed

Put the file at `docs/assets/demo.gif` (create `docs/assets/`), then add under "What a run looks like" in the root `README.md`:

```markdown
![A real run: request to simulated deploy](docs/assets/demo.gif)
```
