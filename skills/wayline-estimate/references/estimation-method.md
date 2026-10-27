# Evidence-backed delivery-effort estimation

Use this method to turn a Delivery Request and an optional local codebase into a reviewable Task Graph. The estimate is a planning aid, not a promise.

## Estimation contract

Every Wayline developer works with AI coding Agents. `estimated_minutes` therefore means **human attention effort**: the minutes a qualified, AI-assisted contributor with normal access to the repository and its documented toolchain must actively spend to satisfy the task's definition of done. Estimates are published to the customer and compared against actuals that developers record on the same basis, so the estimate and the record must measure the same thing.

Counts as effort:

- understanding the requirement, reading the affected code, and deciding the approach;
- writing the specification and instructions an Agent executes, and every steering or correction round;
- reading, understanding, and manually fixing Agent output;
- designing and running verification, debugging, and manual checks;
- pull request preparation, review rounds, CI fixes, manual rollout steps, required migrations, configuration, and documentation;
- expected rework, including defects traced back to the task shortly after delivery.

Does not count:

- Agent runtime while no human is attending it, beyond short supervised waits of about 10 minutes;
- queue time, CI queues, approval or customer-acceptance wait, deployment propagation;
- AI tool or token cost, which is never converted into minutes;
- unrelated pre-existing failures, or contingency already represented by another task.

One wall-clock hour of a developer is at most one hour of effort, however many Agents run concurrently; attention is attributed to the task that holds it. Do not reduce effort because tasks can run in parallel. Never store calendar duration in `estimated_minutes`.

Estimate AI-assisted attention directly. Do not estimate a traditional, unassisted baseline and then discount it, and do not apply published AI productivity multipliers or study results; they measure different tasks, populations, and units. Equally, do not fall back on traditional person-day intuition: AI mainly compresses implementation, leaves understanding, decisions, and external dependencies largely unchanged, and often increases review and verification.

Estimate without reference to budget. Do not look up or ask for subscription hours, remaining capacity, or a target total while estimating. If the request or the user states a budget or target, set it aside until every task estimate is final, and never adjust an estimate to fit it.

Use one team baseline across the graph. Developer Profiles can establish capability fit or expose a skill gap, but names, titles, seniority, and per-developer speed are never applied to graph estimates; the customer sees the same estimate whoever is assigned.

## 1. Establish the scope contract

From `delivery-request context`, identify:

- the requested outcome and observable acceptance criteria;
- explicit in-scope and out-of-scope behavior;
- compatibility, security, performance, migration, and rollout constraints;
- the current graph/version and what must remain stable;
- unresolved decisions that could materially change the graph or more than one task estimate.

Ask only questions whose answers would materially change scope, dependencies, or effort. Otherwise continue with explicit assumptions. Never silently turn an ambiguity into product behavior.

## 2. Perform bounded repository discovery

Record the repository revision and dirty-worktree state, and read applicable repository instructions. Start from the most likely entry point and expand only when a dependency, contract, or contradiction requires it.

Trace a thin vertical slice where relevant:

`input or UI -> validation/auth -> orchestration -> domain logic -> persistence/external effect -> output/error -> tests`

Inspect the affected implementation, public contracts, tests, configuration, migrations, generated boundaries, and deployment integration. Prefer exact symbols, call sites, schemas, manifests, version-control history, and focused verification over directory-wide summaries or file counts.

Also record the signals that drive AI-assisted effort: whether an Agent can run the relevant tests itself, whether the repository has types, conventions, or agent instructions to follow, whether a comparable pattern already exists, and which external systems, credentials, or environments are involved.

Maintain a small evidence ledger for material conclusions:

| Conclusion | Status | Evidence | Estimation effect |
| --- | --- | --- | --- |
| What must change or remain stable | `SOURCE`, `RUNTIME`, `INFERRED`, or `UNKNOWN` | Revision plus path/symbol or command result | Task, assumption, or uncertainty affected |

Use `RUNTIME` only for behavior actually observed by a command or test. Treat documentation and comments as intent evidence that must be reconciled with implementation. If the repository is unavailable, mark code-dependent conclusions `UNKNOWN` rather than fabricating paths or architecture.

Stop discovery once the affected boundaries, likely change path, verification route, and largest unknowns are sufficient to size the work. Estimation must not mutate the repository or begin implementation.

## 3. Decompose into executable tasks

Each task should produce one independently reviewable outcome with a clear definition of done. Prefer thin end-to-end deliverables over separate controller/service/store tasks that cannot be validated alone.

- Include task-local tests, documentation, and ordinary review fixes in the task estimate.
- Create a separate migration, rollout, research spike, or shared-foundation task only when it has its own output, verification, dependency role, or owner boundary.
- Give a research spike a concrete question, artifact, and exit criterion; do not use it as a container for unspecified work.
- Split a task when it crosses independent subsystems, has materially different risks, or cannot be estimated without hiding a large unknown.
- Do not split into cosmetic micro-tasks merely to make estimates look precise; every task carries fixed overhead.
- Model real precedence with edges. Do not use edges to express staffing preferences or arbitrary sequence.
- Keep the Summary node free of estimates and execution work.

For an existing graph, preserve every surviving node and edge ref. Change structure only where the revised scope or code evidence requires it.

## 4. Estimate from evidence

### Classify the task

Assign each task one calibration class from risk and novelty:

- **R1:** low risk and a comparable pattern already exists in the repository.
- **R2:** moderate risk, or a new approach within a known subsystem.
- **R3:** security, money, data migration, or other high-risk change, unknown root cause, or a first-of-its-kind design.

Do not assume an R3 task becomes faster because an Agent is used; its effort is dominated by understanding, decisions, and review depth.

### Build the scenarios from activities

For each task, form three internally consistent scenarios:

- **Optimistic (O):** known path works and no identified risk materializes.
- **Most likely (M):** expected implementation and verification path, including ordinary rework.
- **Pessimistic (P):** plausible identified risks materialize; it is not an unbounded disaster case.

Build every scenario as the sum of the same six activities:

| Activity | Covers | Driven by |
| --- | --- | --- |
| **F** fixed overhead | Context switch, branch and environment setup, opening the pull request | Roughly constant per task |
| **C** understand and decide | Reading the requirement and code, choosing the approach | Requirement clarity, novelty; little AI leverage |
| **S** specify | Turning the approach into Agent-executable instructions and acceptance checks | Quality of C; existing patterns to point at |
| **I** steer implementation | Steering rounds × attention per round, plus manual edits | Self-verification loop, repository conventions, novelty |
| **V** review and verify | Understanding the diff, adding tests, manual checks | Human-relevant diff size × risk class |
| **D** deliver | Review rounds, CI fixes, manual rollout, documentation | Team process and rollout path |

Tie range width to named unknowns such as an unclear contract, unfamiliar code path, no Agent-runnable tests, external integration, permissions, schema migration, generated code, environment setup, or cross-repository coordination. Lines of code, number of files, and developer seniority are context signals, never estimates by themselves.

### Compute the point value

```
E  = (O + 4M + P) / 6
σ  = (P - O) / 6
E' = E × k_team(class)
```

`k_team` corrects the team's systematic bias for a calibration class from recorded actuals:

```
r      = recorded effort (including traced-back rework) / E   for each comparable completed task
k_team = exp( n / (n + 10) × mean(ln r) )                    over the latest 20 tasks of the class
```

The `n / (n + 10)` term shrinks toward 1 while few tasks exist. Use only actuals from this team, recorded on the attention basis above, for genuinely comparable work, and state the class, n, and k used. When no such actuals are available to you, use `k_team = 1.0` and say the estimate is uncalibrated. Never claim calibration from generic benchmarks, published AI studies, or another team's data.

Round E' to practical minutes without hiding material work: normally 15 minutes below 4 hours, 30 minutes from 4 to 16 hours, and 60 minutes above 16 hours. The rounded E' is the point value proposed for the graph. Preserve the unrounded O/M/P range, σ, and k in the local explanation, not in Task Graph fields.

Cold-start priors, used only until the team's own actuals replace them:

| Parameter | Prior | Replace when |
| --- | --- | --- |
| F | 20 minutes per task | about 20 completed tasks |
| k_team | 1.0 | the shrinkage formula takes over as actuals accrue |

Assign confidence from evidence quality, not range width alone:

- **High:** requirement and affected path are clear, with representative tests or a close calibrated precedent.
- **Medium:** the likely path is supported but one material assumption or boundary remains unverified.
- **Low:** requirement-only estimate, unknown root cause, missing integration evidence, or several material assumptions.

If no point estimate is defensible, use null for both estimate fields and explain the discovery needed to make it estimable.

## 5. Check the graph and totals

Before presenting the result:

1. Confirm every requirement and necessary delivery obligation maps to a task or an explicit exclusion.
2. Check that task definitions do not overlap and shared overhead is counted once.
3. Check that edges reflect actual dependency direction and the graph satisfies the Task Graph protocol.
4. Sum the graph point values as **total effort**. Do not call the sum delivery duration.
5. Aggregate uncertainty. Treat tasks that share the same unknown as fully correlated:

   ```
   σ_total = sqrt( Σ σ_i² over independent tasks + Σ (Σ σ_i within group)² over shared-risk groups )
   P80     = total effort + 0.84 × σ_total
   ```

6. Only after every task estimate is final, relate the total to capacity when the user or the request context supplies it: weekly capacity hours, remaining hours in the current period, and the shares of those hours reserved for coordination (`o`: syncs, estimation, reporting) and interrupts (`u`). If any share is missing, state the value you assume and why. Never assume a default capacity; when none is supplied, skip this step and report total effort and P80 only.

   ```
   C_week = weekly capacity hours × (1 - o - u)
   weeks  ≈ ceil(P80 / C_week)
   ```

   Coordination and interrupts consume capacity but are not task effort; never add them to task estimates, and never revise an estimate because of this step. List external waits such as customer acceptance separately instead of converting them to effort. If P80 exceeds the remaining capacity of the current week or period, flag that the work will span weeks or may exceed the contracted hours, so the overrun terms can be raised before work starts.
7. Identify the largest estimate drivers and the assumptions that would trigger re-estimation.

Re-estimate when scope changes, a hidden dependency appears, the assumed architecture is contradicted, verification reveals a different root cause, an estimate-driving assumption becomes false, or recorded effort on an unfinished task exceeds 1.2 × its graph estimate. Distinguish scope change from estimation error in the explanation, because contract terms may treat them differently. Preserve the original basis in the local conversation; do not present a changed estimate as though it had always been known.

## 6. Report before submission

Lead with the proposed total effort, P80, confidence, and whether the estimate is calibrated, then show enough evidence for a human to challenge the result. Use a compact task table with:

| Task/ref | Deliverable and definition of done | Class | Code evidence | O / M / P | k | Graph minutes | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- |

Follow it with:

- scope and exclusions;
- assumptions and unresolved questions;
- main risk and re-estimation triggers;
- relevant code locations or command results;
- total effort and P80, plus, when capacity was supplied, the capacity inputs used, approximate weeks, and any overrun flag.

The graph stores only the supported point value and `estimate_source: "ai"`. Do not put analysis transcripts, classes, confidence labels, ranges, calibration factors, risk registers, schedules, or evidence ledgers into task descriptions merely to preserve them. Submit only after the user asks to persist the proposed version.
