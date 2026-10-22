# Evidence-backed delivery-effort estimation

Use this method to turn a Delivery Request and an optional local codebase into a reviewable Task Graph. The estimate is a planning aid, not a promise.

## Estimation contract

`estimated_minutes` means active developer delivery effort for a qualified contributor with normal access to the repository and its documented toolchain. Include the work required to satisfy the task's definition of done:

- remaining task-specific discovery and design;
- implementation and integration;
- tests and other verification;
- migrations, configuration, documentation, or rollout work required by the change;
- expected review fixes and task-local rework.

Do not include queue time, approval wait, deployment propagation, unrelated pre-existing failures, Agent runtime, token consumption, or contingency already represented by another task. Do not reduce effort because tasks can run in parallel. If the user asks for delivery duration, derive it separately from dependencies, staffing, and availability; never store calendar duration in `estimated_minutes`.

Use one consistent baseline across the graph. Developer Profiles can establish capability fit or expose a skill gap, but names, titles, or seniority alone are not productivity evidence. Do not personalize estimates unless the user explicitly supplies a supported productivity assumption.

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
- Do not split into cosmetic micro-tasks merely to make estimates look precise.
- Model real precedence with edges. Do not use edges to express staffing preferences or arbitrary sequence.
- Keep the Summary node free of estimates and execution work.

For an existing graph, preserve every surviving node and edge ref. Change structure only where the revised scope or code evidence requires it.

## 4. Estimate from evidence

For each task, form three internally consistent scenarios:

- **Optimistic (O):** known path works and no identified risk materializes.
- **Most likely (M):** expected implementation and verification path, including ordinary rework.
- **Pessimistic (P):** plausible identified risks materialize; it is not an unbounded disaster case.

Build each scenario from the same work categories: discovery/design, implementation, verification, and expected rework/delivery obligations. Tie range width to named unknowns such as an unclear contract, unfamiliar code path, missing tests, external integration, permissions, schema migration, generated code, environment setup, or cross-repository coordination. Lines of code, number of files, and developer seniority are context signals, never estimates by themselves.

Use the PERT expected value as the point estimate proposed for the graph:

`E = (O + 4M + P) / 6`

Round the result to practical minutes without hiding material work: normally 15 minutes below 4 hours, 30 minutes from 4 to 16 hours, and 60 minutes above 16 hours. Preserve the unrounded O/M/P range in the local explanation, not in Task Graph fields.

Assign confidence from evidence quality, not range width alone:

- **High:** requirement and affected path are clear, with representative tests or a close calibrated precedent.
- **Medium:** the likely path is supported but one material assumption or boundary remains unverified.
- **Low:** requirement-only estimate, unknown root cause, missing integration evidence, or several material assumptions.

If historical actuals for genuinely comparable work are available, use them as an explicit anchor and state the comparison. Never claim calibration from generic model benchmarks or another repository. If no point estimate is defensible, use null for both estimate fields and explain the discovery needed to make it estimable.

## 5. Check the graph and totals

Before presenting the result:

1. Confirm every requirement and necessary delivery obligation maps to a task or an explicit exclusion.
2. Check that task definitions do not overlap and shared overhead is counted once.
3. Check that edges reflect actual dependency direction and the graph satisfies the Task Graph protocol.
4. Sum task point estimates as **total effort**. Do not call the sum delivery duration.
5. Identify the largest estimate drivers and the assumptions that would trigger re-estimation.

Re-estimate when scope changes, a hidden dependency appears, the assumed architecture is contradicted, verification reveals a different root cause, or an estimate-driving assumption becomes false. Preserve the original basis in the local conversation; do not present a changed estimate as though it had always been known.

## 6. Report before submission

Lead with the proposed total effort and confidence, then show enough evidence for a human to challenge the result. Use a compact task table with:

| Task/ref | Deliverable and definition of done | Code evidence | O / M / P | Graph minutes | Confidence |
| --- | --- | --- | --- | --- | --- |

Follow it with:

- scope and exclusions;
- assumptions and unresolved questions;
- main risk and re-estimation triggers;
- relevant code locations or command results;
- total effort, plus calendar-duration assumptions only if requested.

The graph stores only the supported point value and `estimate_source: "ai"`. Do not put analysis transcripts, confidence labels, ranges, risk registers, schedules, or evidence ledgers into task descriptions merely to preserve them. Submit only after the user asks to persist the proposed version.
