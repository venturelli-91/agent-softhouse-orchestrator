# Discovery agent live eval (hand grading)

Branch `feat/discovery-triage`, commit 42d73c5. Prompts under test: `orchestrator/agents/discovery.md`, `orchestrator/agents/triage.md`.
Acceptance criterion: design `2026-11-15-orchestrator-lean-triage-production-design.md`, Part 2 (AC at line 99).

## Run

```
cd orchestrator && node --env-file=.env scripts/eval-stages.ts --models claude-sonnet-5-5 --stages discovery --reps 3
```

Summary line: `claude-sonnet-5-5 discovery: 30/30 correct, 415759 tokens, US$0.657`

- Code checks: 15/15 clear runs stayed at triage; 15/15 vague runs had ready=false, 4-5 questions, non-empty `why` and `default`.
- Questions printed: 73 (13 runs x 5, 2 runs x 4).
- Raw output: `.superpowers/sdd/2026-11-16-discovery-triage/task-4-eval-output.txt`.

Fixture README (seeded): B2B buyers on desktop; checkout in `src/checkout.ts`; prices in BRL; data under LGPD. The fixture has `checkout.html` and no `src/checkout.ts`, so a question about that contradiction is legitimate.

## Criteria

1. **Repo**: fail if the seeded README or repo states the answer.
2. **Specific**: fail if it is boilerplate that would fit any request, or not a CEO question.
3. **Problem-first** (per run): the first question is about the problem, pain or a real case, and solution details come after it. Block column: Pb problem/pain, Gl goal/success, Us users/context, Sc scope/limits, Cr constraints/risks, Ca real case.
4. **One ask**: defect if one question bundles asks that feed different decisions, e.g. "...and is there a deadline?" tacked on, or problem plus real case. A list of options for one decision counts as one ask.

## Grading table

Legend: ok = pass, X = fail/defect, ~ = borderline (counted as pass).

### "Add a discount to the cart."

| Run | # | Question (short) | Block | Repo | Specific | One ask |
|---|---|---|---|---|---|---|
| 1 | 1 | business problem + discount type | Pb+Sc | ok | ok | X |
| 1 | 2 | rules: %/fixed, min, expiry, limit, stacking | Sc | ok | ok | X |
| 1 | 3 | who manages + where data lives (no backend, src/checkout.ts missing) | Cr | ok | ok | X |
| 1 | 4 | how we know it worked | Gl | ok | ok | ok |
| 1 | 5 | one real recent case | Ca | ok | ok | ok |
| 2 | 1 | which scenario, real example | Ca | ok | ok | ok |
| 2 | 2 | %/fixed + code/auto + whole cart/items | Sc | ok | ok | X |
| 2 | 3 | limits: max, min, expiry, cap, stacking | Sc | ok | ok | X |
| 2 | 4 | who manages + who is eligible | Us | ok | ok | X |
| 2 | 5 | success + launch date | Gl+Sc | ok | ok | X |
| 3 | 1 | what kind of discount (coupon/auto/manual) | Sc | ok | ok | ok |
| 3 | 2 | value + limits | Sc | ok | ok | X |
| 3 | 3 | who is eligible | Us | ok | ok | ok |
| 3 | 4 | target use case + success metric | Gl | ok | ~ | X |
| 3 | 5 | one real recent case | Ca | ok | ok | ok |

Problem-first: run 1 yes, run 2 yes, **run 3 no** (opens with the solution type and never asks the problem). Run 3 Q2 default "Percentage or fixed BRL amount" is a list, not an assumption.
Tally: repo 15/15, specific 15/15 (1 ~), problem-first 2/3 runs, one ask 6/15.

### "Make the app better."

| Run | # | Question (short) | Block | Repo | Specific | One ask |
|---|---|---|---|---|---|---|
| 1 | 1 | main checkout pain (pick one) | Pb | ok | ok | ok |
| 1 | 2 | one recent case | Ca | ok | ok | ok |
| 1 | 3 | how you will know it got better | Gl | ok | ok | ok |
| 1 | 4 | scope + where src/checkout.ts is | Sc | ok | ok | X |
| 1 | 5 | deadline + limits (budget, deps, LGPD) | Sc+Cr | ok | ok | X |
| 2 | 1 | problem + recent real case | Pb+Ca | ok | ok | X |
| 2 | 2 | one measurable outcome | Gl | ok | ok | ok |
| 2 | 3 | checkout.html only or build src/checkout.ts | Sc | ok | ok | ok |
| 2 | 4 | deadline, stack, LGPD obligations | Sc+Cr | ~ | ok | X |
| 2 | 5 | English label or pt-BR UI | Us | ok | ok | ok |
| 3 | 1 | what is wrong + recent case | Pb+Ca | ok | ok | X |
| 3 | 2 | how we know it is better | Gl | ok | ok | ok |
| 3 | 3 | only checkout in scope + is src/checkout.ts elsewhere | Sc | ok | ok | X |
| 3 | 4 | deadline, deps, pt-BR, LGPD for fields | Sc+Cr | ok | ok | X |
| 3 | 5 | split into tickets (UI, API, data)? | - | ok | **X** | ok |

Problem-first: 3/3. Run 2 Q4 ~: README already says data falls under LGPD; asking whether LGPD obligations exist is half answered (which obligations is not). Run 3 Q5 is the planner's decision, not a question for the CEO.
Tally: repo 15/15 (1 ~), specific 14/15, problem-first 3/3, one ask 8/15.

### "We need reports."

| Run | # | Question (short) | Block | Repo | Specific | One ask |
|---|---|---|---|---|---|---|
| 1 | 1 | decision to support + last time it was missing | Pb+Ca | ok | ok | X |
| 1 | 2 | first 3-5 numbers | Gl | ok | ok | ok |
| 1 | 3 | where data lives, what is not captured | Cr | ok | ok | ok |
| 1 | 4 | who reads + in what form | Us+Sc | ok | ok | X |
| 1 | 5 | customer-level data + deadline | Cr+Sc | ok | ok | X |
| 2 | 1 | decision + what happened recently | Pb+Ca | ok | ok | X |
| 2 | 2 | first 3-5 numbers | Gl | ok | ok | ok |
| 2 | 3 | who reads + how often | Us | ok | ok | X |
| 2 | 4 | where order data lives | Cr | ok | ok | ok |
| 2 | 5 | format + deadline | Sc | ok | ok | X |
| 3 | 1 | decision + example from last week | Pb+Ca | ok | ok | X |
| 3 | 2 | metrics and periods | Gl | ok | ok | ok |
| 3 | 3 | where data lives, can we read it | Cr | ok | ok | ok |
| 3 | 4 | who views + roles + personal data under LGPD | Us+Cr | ok | ok | X |
| 3 | 5 | format/frequency + deadline | Sc | ok | ok | X |

Problem-first: 3/3. Tally: repo 15/15, specific 15/15, problem-first 3/3, one ask 6/15.

### "Improve the checkout."

| Run | # | Question (short) | Block | Repo | Specific | One ask |
|---|---|---|---|---|---|---|
| 1 | 1 | specific pain + metric/complaint behind it | Pb+Ca | ok | ok | X |
| 1 | 2 | is this repo the whole checkout (src/checkout.ts missing) | Cr | ok | ok | ok |
| 1 | 3 | measurable result | Gl | ok | ok | ok |
| 1 | 4 | which flow parts in/out (CNPJ, PIX, boleto...) | Sc | ok | ok | ok |
| 1 | 5 | deadline, LGPD data, tooling | Sc+Cr | ok | ok | X |
| 2 | 1 | specific pain + recent case | Pb+Ca | ok | ok | X |
| 2 | 2 | metric/visible result and target | Gl | ok | ok | ok |
| 2 | 3 | checkout.html only or src/checkout.ts, order logic, payment | Sc | ok | ok | ok |
| 2 | 4 | which buyer fields may be collected + deadline | Cr+Sc | ok | ok | X |
| 3 | 1 | specific problem + real case | Pb+Ca | ok | ok | X |
| 3 | 2 | which metric and target | Gl | ok | ~ | ok |
| 3 | 3 | which step in scope + should src/checkout.ts exist | Sc | ok | ok | X |
| 3 | 4 | gateway/backend + B2B needs + deadline | Cr+Sc | ok | ok | X |

Problem-first: 3/3. Tally: repo 13/13, specific 13/13 (1 ~), problem-first 3/3, one ask 6/13.

### "Customers complain about login."

| Run | # | Question (short) | Block | Repo | Specific | One ask |
|---|---|---|---|---|---|---|
| 1 | 1 | exact complaints, paste 2-3 tickets | Pb | ok | ok | ok |
| 1 | 2 | where login code is (repo has none) | Cr | ok | ok | ok |
| 1 | 3 | since when, how many, how bad | Pb | ok | ok | ok |
| 1 | 4 | what tells you it is fixed | Gl | ok | ok | ok |
| 1 | 5 | deadline + off-limits changes | Sc+Cr | ok | ok | X |
| 2 | 1 | what goes wrong (symptom) | Pb | ok | ok | ok |
| 2 | 2 | 2-3 real complaints | Ca | ok | ok | ok |
| 2 | 3 | where login lives + who gives log access | Cr | ok | ok | X |
| 2 | 4 | since when, everyone or some | Pb | ok | ok | ok |
| 2 | 5 | diagnose/fix or redesign | Sc | ok | ok | ok |
| 3 | 1 | exact complaints, paste tickets | Pb | ok | ok | ok |
| 3 | 2 | one case step by step (browser, method) | Ca | ok | ok | ok |
| 3 | 3 | where login lives | Cr | ok | ok | ok |
| 3 | 4 | what tells you it is fixed | Gl | ok | ok | ok |
| 3 | 5 | outage now / since when + deadline | Pb+Sc | ok | ok | X |

Problem-first: 3/3. Tally: repo 15/15, specific 15/15, problem-first 3/3, one ask 12/15. Best request of the set.

## Totals

| Criterion | Result |
|---|---|
| Answerable from README/repo (AC hard gate) | **0/73 fail** (1 borderline: LGPD sub-ask, app-better run 2 Q4) |
| Specific to the request | 72/73 (1 fail: ticket-split question; 3 borderline generic success questions) |
| Problem-first (runs) | 14/15 (discount run 3 opens with the solution) |
| One ask per question | 38/73 clean, **35/73 bundled** (48%) |
| Default is one concrete assumption | 72/73 (discount run 3 Q2 gives a list) |

What went well: no question asks for a README fact (B2B, desktop, BRL, LGPD are used as assumptions in defaults, e.g. "desktop screen", "R$ 10.000"); the `src/checkout.ts` contradiction and the missing auth/data layer are raised correctly; every `why` names what changes in the build; every run covers success and almost every run asks for a real case.

Recurring defects:
1. Bundling (35/73). Two patterns cover most of it: "...Is there a deadline?" tacked onto an unrelated question (12 times), and problem plus real case in one question (8 times). A CEO answering one line tends to answer only the first ask, so the second one silently falls to its default.
2. One run is solution-first (discount run 3).
3. One process question that is the planner's job (ticket split).
4. One non-committal default.

## Verdict: PASS WITH CHANGES

The Part 2 AC holds: clear requests never reach discovery, every vague run has at most 5 questions with `why` and `default`, and no question is answerable from the repo. Not standard as is because almost half the questions bundle several asks, and the prompt does not say the first question must be the problem. Both are one-sentence prompt fixes; no code or schema change.

### Exact prompt edit (`orchestrator/agents/discovery.md`, line 8)

Replace:

```
Ask at most 5 questions, ordered by impact, each specific to this request. Every question has `why` (what the answer changes) and `default` (what will be assumed if it is skipped).
```

With:

```
Ask at most 5 questions, ordered by impact, each specific to this request and each asking one thing: never append a second topic (such as "is there a deadline?") to a question; a gap that does not fit becomes an assumption. Your first question is about the problem or pain behind the request, not about the solution. Do not ask how to split the work into tickets; that is the planner's job. Every question has `why` (what the answer changes) and `default` (one concrete assumption, never a list of options).
```

`triage.md`: no change (15/15 clear and 15/15 vague routed correctly).

After the edit, rerun the same command once (about US$0.66) and recheck by hand: bundled questions at or below 10% (7/73), first question problem-first in 15/15 runs, still 0 repo-answerable questions. If those numbers hold, the prompt can become standard.

---

# Run 2 (after the prompt edit)

Commit 3d1b6a3: `discovery.md` line 8 replaced with the Run 1 proposed text. Fixture changes: the README is seeded only for the discovery stage; the checkout line is now "Checkout is in checkout.html." (matches the fixture); triage context deduplicated.

## Run

```
cd orchestrator && node --env-file=.env scripts/eval-stages.ts --models claude-sonnet-5-5 --stages discovery --reps 3
```

Summary line: `claude-sonnet-5-5 discovery: 29/30 correct, 449042 tokens, US$0.649`

- 1 miss: the clear chatbot-memory request was marked unclear by triage in 1 of 3 reps and reached discovery (its questions are not printed).
- 15/15 vague runs passed the code checks; 71 questions printed (11 runs x 5, 4 runs x 4).
- Raw output: `.superpowers/sdd/2026-11-16-discovery-triage/task-4-eval-output-2.txt`.

Pass bar set in Run 1: bundled at or below 10%, 15/15 runs problem-first, 0 questions answerable from the repo. Same criteria and legend as Run 1. Only rows with a defect or borderline mark are listed; every other question is ok on all four criteria.

## Grading table (defects and borderline only)

| Request | Run | # | Question (short) | Repo | Specific | One ask | Note |
|---|---|---|---|---|---|---|---|
| Discount | 1 | 5 | how long + can it combine | ok | ok | X | expiry vs stacking |
| Discount | 2 | 1 | business problem + what happened recently | ok | ok | X | problem + case |
| Discount | 2 | 4 | can it combine + expiry/usage limit | ok | ok | X | stacking vs expiry |
| Discount | 3 | 2 | how we know it worked + one concrete example | ok | ok | X | success + case |
| Discount | 3 | 4 | who sets values + who may use (+ expiry) | ok | ok | X | three decisions |
| Reports | 1 | 1 | decision/pain, e.g. what happened recently | ok | ok | ~ | 2nd clause phrased as example of the 1st |
| Reports | 1 | 4 | who reads + in what form | ok | ok | X | audience vs format |
| Reports | 2 | 1 | decision + how you get it today | ok | ok | X | problem + current process |
| Reports | 2 | 3 | who opens + how often | ok | ok | X | access vs scheduling |
| Reports | 3 | 3 | who reads + how often | ok | ok | X | access vs scheduling |
| Checkout | 2 | 1 | what went wrong + give one concrete case | ok | ok | X | problem + case |
| Login | 2 | 4 | where login runs + can we access it | ok | ok | X | location vs access |

Discount run 1 Q2 offers "percentage, fixed BRL amount, or coupon code" as one choice (value type and mechanism mixed in one option list): one ask, sloppy options, not counted.

## Tallies

| Request | Questions | Repo-answerable | Specific | Problem-first (runs) | Bundled |
|---|---|---|---|---|---|
| Add a discount to the cart. | 15 | 0 | 15/15 | 3/3 | 5 |
| Make the app better. | 13 | 0 | 13/13 | 3/3 | 0 |
| We need reports. | 15 | 0 | 15/15 | 3/3 | 4 (1 ~) |
| Improve the checkout. | 13 | 0 | 13/13 | 3/3 | 1 |
| Customers complain about login. | 15 | 0 | 15/15 | 3/3 | 1 |
| **Total** | **71** | **0** | **71/71** | **15/15** | **11/71 = 15.5%** |

Run 1 vs Run 2: bundled 48% -> 15.5%; deadline tacked onto another question 12 -> 0; problem-first 14/15 -> 15/15; ticket-split questions 1 -> 0; list-style defaults 1 -> 0; repo-answerable stays 0.

Bar: 0 answerable ok, 15/15 problem-first ok, **bundled 15.5% misses the 10% bar**. The remaining bundles are two asks about the same topic (who reads + how often; stacking + expiry; problem + recent case), each with one default covering both. That costs less than the unrelated tack-ons Run 1 had, but it is still a miss against the bar.

## Triage miss

The AC says clear requests **never** reach discovery; 1 in 15 clear runs (6.7%) did, so the AC is not met. It is not acceptable variance. The miss is always the same request: the chatbot request names the change and has a "done when" test, but the fixture repo has no chatbot code, and the "when in doubt, clear=false" line (added in this branch) lets the model treat missing code or open implementation details (where the memory lives) as doubt. The cost is one avoidable CEO interrupt on a request that was already specified, and it will recur on any clear request for code not yet in the repo.

## Verdict Run 2: PASS WITH CHANGES

Discovery: 2 of 3 bar items pass, bundling misses. Triage: the AC "never" is broken by one rep. One edit to each prompt, then one rerun covers both.

### Exact edit 1 (`orchestrator/agents/triage.md`, line 6)

Replace:

```
clear=true only when the request names the problem or the exact change, has a verifiable criterion, and its scope is unambiguous. 'Adjust the spacing of card X' is clear; 'improve the checkout' is not. When in doubt, clear=false.
```

With:

```
clear=true only when the request names the problem or the exact change, has a verifiable criterion, and its scope is unambiguous. 'Adjust the spacing of card X' is clear; 'improve the checkout' is not. A request that states the change and a 'done when' check is clear even if the code it touches does not exist yet or implementation details (storage, library, file) are open: those are the dev's choices, not doubt. Otherwise, when in doubt, clear=false.
```

### Exact edit 2 (`orchestrator/agents/discovery.md`, line 8)

Replace:

```
each asking one thing: never append a second topic (such as "is there a deadline?") to a question;
```

With:

```
each asking one thing: one question mark and no second ask joined by "and" (such as "is there a deadline?", "how often?" or "give an example");
```

### Rerun

Same command, plus a triage-only run with more reps for the clear set:

```
cd orchestrator && node --env-file=.env scripts/eval-stages.ts --models claude-sonnet-5-5 --stages discovery --reps 3
cd orchestrator && node --env-file=.env scripts/eval-stages.ts --models claude-sonnet-5-5 --stages triage --reps 5
```

Standard when: 0 clear requests reach discovery (and 5/5 on chatbot in the triage run), all vague requests still reach it, bundled at or below 10%, 15/15 problem-first, 0 repo-answerable. Optional, not done here: an eval code check "one `?` per question" would count most bundles automatically.

---

# Run 3 (after the Run 2 edits)

Commit 2667395: both Run 2 edits applied verbatim (`triage.md` line 6, `discovery.md` line 8).

## Runs

```
cd orchestrator && node --env-file=.env scripts/eval-stages.ts --models claude-sonnet-5-5 --stages discovery --reps 3
cd orchestrator && node --env-file=.env scripts/eval-stages.ts --models claude-sonnet-5-5 --stages triage --reps 5
```

- `claude-sonnet-5-5 discovery: 30/30 correct, 427789 tokens, US$0.625`. No clear request reached discovery; 15/15 vague runs passed the code checks; 72 questions (13 runs x 5, 1 x 4, 1 x 3).
- `claude-sonnet-5-5 triage: 50/55 correct, 260175 tokens, US$0.344`. Chatbot request 5/5. All 5 misses are the Stripe webhook request: clear=true (correct), specialty `backend` instead of `integrations`.
- Raw output: `.superpowers/sdd/2026-11-16-discovery-triage/task-4-eval-output-3.txt` and `task-4-eval-output-triage.txt`.

Same criteria and legend as Run 1; only rows with a defect or borderline mark are listed.

## Grading table (defects and borderline only)

| Request | Run | # | Question (short) | Repo | Specific | One ask | Note |
|---|---|---|---|---|---|---|---|
| Make the app better. | 1 | 5 | hard deadline or off-limits area | ok | ok | X | deadline vs scope limit |
| We need reports. | 3 | 4 | format + how often | ok | ok | X | format vs scheduling |
| Improve the checkout. | 1 | 5 | deadline or compliance requirement (LGPD consent text) | ~ | ok | X | README says LGPD applies; whether this change needs consent text is open |
| Improve the checkout. | 2 | 1 | specific problem + what happened when a buyer hit it | ok | ok | X | problem + case |
| Customers complain about login. | 1 | 4 | all customers or a segment, platform or browser | ~ | ok | ok | README says desktop; default "web and mobile" contradicts it |
| Customers complain about login. | 3 | 4 | which system holds login + who owns it | ok | ok | X | location vs owner |

## Tallies

| Request | Questions | Repo-answerable | Specific | Problem-first (runs) | Bundled |
|---|---|---|---|---|---|
| Add a discount to the cart. | 15 | 0 | 15/15 | 3/3 | 0 |
| Make the app better. | 15 | 0 | 15/15 | 3/3 | 1 |
| We need reports. | 15 | 0 | 15/15 | 3/3 | 1 |
| Improve the checkout. | 13 | 0 (1 ~) | 13/13 | 3/3 | 2 |
| Customers complain about login. | 14 | 0 (1 ~) | 14/14 | 3/3 | 1 |
| **Total** | **72** | **0** | **72/72** | **15/15** | **5/72 = 6.9%** |

Across runs: bundled 48% -> 15.5% -> 6.9%; clear requests reaching discovery 0/15 -> 1/15 -> 0/15 (plus chatbot 5/5 in the triage run).

Bar: no clear request reaches discovery: met. Bundled at or below 10%: met. 15/15 problem-first: met. 0 repo-answerable: met (2 borderline, not counted).

Non-blocking note: login run 1 Q4 default ("web and mobile") ignores the README fact "desktop". It appears once in 72 defaults; watch it in production, no prompt edit.

## Stripe specialty miss

Not blocking; follow-up ticket.
- Part 2's AC covers clarity and discovery only; Stripe is classified clear=true 5/5, which is the part this ticket owns.
- It predates this branch: the Stripe case was added on main in 43d1082 (2026-11-01). The specialty sentence of `triage.md` is untouched on this branch (`git diff main...HEAD` changes only the clear line). The model matrix recorded in that commit (`08-real-repo-validation.md`) already shows Sonnet triage/planner at 24/27 and 22/27 without naming the misses, so it cannot confirm that Stripe was among them.
- The prompt lists `integrations` as a specialty but never says when to pick it over `backend`, and the request is literally "Add POST /webhooks/..." (a backend endpoint).

Follow-up ticket (P2, `ai-engineer` + `evals-engineer`): in `triage.md`, after the specialty list, add "Pick `integrations` when the work's core is a third-party service (webhook, OAuth, external API), even if it adds an endpoint." Then rerun `--stages triage --reps 5` and expect Stripe 5/5 with no regression on the other 10 requests. Routing impact meanwhile: an integrations ticket goes to `dev-backend` and keeps its `touches_external_integration` flag, so the external-integration approval gate still applies. This assumes the flag was set in those runs: the miss line prints clear, priority and specialty but not the flags, so it is unverified.

## Final verdict: PASS

`discovery.md` (line 8 as of 2667395) and `triage.md` (line 6 as of 2667395) can become standard. Part 2's AC holds on a live run: clear requests never reached discovery (15/15, plus chatbot 5/5), every vague run has at most 5 questions with `why` and `default`, none is answerable from the repo, and the quality bar (one ask, problem-first) is met. Cost of the three eval rounds: US$0.657 + US$0.649 + US$0.625 + US$0.344 = US$2.275.
