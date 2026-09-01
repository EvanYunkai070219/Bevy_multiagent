# Task 11 report — Prove Milestone 2 with Deterministic, Adversarial, and Real-Provider Gates

**Status:** DONE_WITH_CONCERNS  
**Branch:** `feat/self-evolving-new` (base `6d9686518cb76dfa134ea353f493476518c549a6`)  
**Commit:** recorded after this report is committed as `test: prove bounded self-healing milestone two`

## Delivered

1. Added a deterministic, real-local-Git three-node fixture (`frontend`, `backend`, `integration`) that drives the existing AgentService, ProjectRunManager, registries, verifier, evidence store, coordination server, scheduler, and orchestrator APIs. Model/runtime responses and verifier process results are deterministic test adapters; orchestration and Git promotion remain product paths.
2. Added the complete success trace, normal-success path, fail-closed scenario matrix, runtime/budget/dependency assertions, and named mutation-sensitive acceptance assertions.
3. Added `npm run demo:self-healing`, with the exact ordered trace, run/project/branch/base/final/tree identifiers, bounded usage, cleanup result, and source-branch integrity.
4. Documented the opt-in configuration, authority boundary, `429` handling, root/leader/solo/async deadlines, trusted timeout leases, workspace map, evidence and manual landing, and Milestone 3 deferrals. Added the corresponding `.env.example` surface.
5. Refreshed durable worker/healing state after draining asynchronous dispatches and before deciding whether the leader contribution is required. This prevents a concurrent leader from publishing a false completed outcome from stale in-memory worker state.
6. Tightened acceptance infrastructure without weakening lifecycle checks: bounded container readiness polling now permits up to 20 seconds inside the existing 40-second test timeout; cleanup resolves the actual production `--name` and still verifies owner labels/ID; EventLog teardown uses its authoritative close barrier.

## Acceptance evidence

### Focused and deterministic gates

- Exact focused acceptance command: `2 files passed / 33 tests passed / 1 real-provider test skipped`, duration `177.08s`.
- Exact demo-test repetition: `20/20` green with identical terminal status, winner family, final tree, candidate counts, and bounds.
- Additional command-level deterministic demo repetition: `20/20` green.
- One-command demo: green. Evidence from the recorded run:
  - run `66c9af7f-bc53-489d-a027-841026c76217`
  - project `b3727da4-86d4-46d8-98cf-39c09bc5466d`
  - branch `launchpad/run/66c9af7f-bc53-489d-a027-841026c76217`
  - base `4d82b6de513580aad9551603f02ce2f1635de08c`
  - final `09a77a67c0db3be86602771da09e690da10b49cc`
  - tree `b0d61d63cc9f9c549f199f99805102c0cc6a2828`
  - 7 calls, 0 reserved tokens, 6 actual tokens, 35,461 ms, cleanup `removed`, source integrity `true`.
- Non-container lifetime/teardown gate: `6 files passed / 147 tests passed / 0 failed`, duration `66.54s`.
- EventLog repetition: the first sequence was stopped at repetition 21 after an `ENOTEMPTY` exposed a missing test close barrier (20 green, then one red). After the single approved close-barrier fix, its focused regression was `1/1` green and the prescribed sequence was restarted from 1 exactly once: `50/50` green, zero `ENOTEMPTY`.
- `git diff --check`: green on the final pre-commit tree.

### Container gate

The exact full container gate was run once and produced `17 passed / 1 failed`. The failure was the runtime-app-server fixture's fixed five-second readiness horizon under parallel load, not a failed absence/immutability assertion. Instrumentation observed the expected `late.txt` content at about `5.5s` (360 bytes). After approval, readiness alone was extended to a bounded 20 seconds within the existing 40-second test timeout, and cleanup was corrected to parse the real production `--name` while retaining exact owner-label/ID verification. The affected regression then passed `1/1` (`13 skipped`) in `7.36s`. Per instruction, the unchanged full container command was not rerun.

The failed fixture's exact leaked test artifact, container `3c94546c092299f7eea4ccfc04f9da975bf523413777470568676b9a0b42227d`, was re-inspected as `created` with the expected `app-server-quiesce` owner labels and removed by exact ID. No wildcard or name-based deletion was used.

### Repository gate

- Initial exact `npm run typecheck`: green.
- Initial exact `npm test`: red once, and was not blindly rerun. Server reported `1024 passed / 7 failed / 4 skipped` plus one unhandled rejection; web reported `8/8` passed; duration `669.4s`.
- Diagnosis identified two stale test policies whose partial objects omitted the newer `rootTimeoutMs`, causing `TimeoutNaN`/effectively immediate root deadlines; those fixtures now spread `defaultExecutionPolicy`. One worker-prompt assertion also assumed obsolete synchronous dispatch semantics and now verifies running ingress followed by durable settlement. Focused regressions were green: projects/chats `10/10`; timeout-heavy AgentService `1/1` (`59 skipped`); worker-prompt `1/1` (`35 skipped`). The contribution-integrator and blocked-dependent failures each passed in one focused isolation, so product behavior was not changed for them.
- Changed-tree `npm run typecheck`: green.
- The changed-tree root `npm test` rerun was interrupted on explicit wrap-up instruction and is not claimed as green. At interruption it emitted a failure for `orchestration-self-healing-integration.test.ts` (`dispatches a live-leader wave, overlaps siblings, heals backend, and does not restart frontend`). No unchanged retry was run.
- Root `npm run build` was not run after the red/interrupted test gate, per the instruction to stop testing and finalize immediately.

## Mutation evidence

All named mutation-sensitive assertions are present and restored on the committed tree. The acceptance coverage maps the Task 11 list as follows:

- root race removal: named leader/solo/async never-settling root-race assertion;
- missing async-dispatch failure drain: fail-closed live-dispatch assertion;
- late worker completion after terminal revision: durable terminal worker-state assertion;
- untrusted/excess timeout extension: named trusted-progress/root-deadline tests in runtime lifetime coverage;
- descendant surviving background-shell cancellation: named process-tree cancellation assertion;
- hidden forbidden/repeated batch operation: named nested-batch sleep-guard assertion;
- fallback Git hash replacing last valid fingerprint: fingerprint preservation assertion;
- provider failure diagnosis: provider failures remain non-repairable;
- missing trusted authority: authority-compromise and verification denial assertions;
- agent-authored test authorization: self-authorization denial assertion;
- missing manifest asset hash: exact authority-asset completeness assertion;
- missing owner/revision CAS: promotion-conflict assertion;
- fourth candidate/second tournament: exact config and candidate-count assertions;
- mutant winning a tie: independently constructed control-tie winner assertion;
- winner outside integration queue: queued-integration assertion;
- completion before post-integration gate: post-gate ordering assertion;
- omitted rollback clean/reset: clean canonical rollback assertion;
- consumer starting while producer repairs: scheduler/dependency assertions;
- synthesis with required failed/blocked node: zero-synthesizer-call assertion.

The concurrency-sensitive durable-state mutation was also applied physically: removing the post-drain refresh allowed the exact combined acceptance/demo command to publish a false two-node success with zero repeated failures, diagnosis, candidates, or integration. Restoring the refresh returned the focused gate to `33 passed / 1 skipped`. Earlier Task 9/10 reports retain the physical mutation evidence for the underlying authority, CAS, deadline, cancellation, process-tree, batch, fingerprint, tournament, integration, rollback, dependency, and synthesis mechanisms.

## Real-provider smoke

The required bounded configuration was absent: smoke opt-in `false`, provider key `false`, model `false`, smoke config `false`. Result: `0/3` trials run and one explicit opt-in test skipped. No provider result is relabelled and no credential was exposed.

## Files

Created:

- `apps/server/scripts/self-healing-demo-fixture.ts`
- `apps/server/scripts/self-healing-demo.ts`
- `apps/server/tests/self-healing-m2-acceptance.test.ts`
- `apps/server/tests/self-healing-m2-demo.test.ts`
- `scripts/run-self-healing-m2.sh`
- `.superpowers/sdd/2026-08-29-self-healing-integration-milestone-2/task-11-report.md`

Modified:

- `.env.example`
- `apps/server/package.json`
- `apps/server/src/orchestration/orchestrator.ts`
- `apps/server/tests/config.test.ts`
- `apps/server/tests/git-client.test.ts`
- `apps/server/tests/launchpad-mcp-server.test.ts`
- `apps/server/tests/orchestration-runtime-lifetime.test.ts`
- `apps/server/tests/orchestrator-sleep-guard.test.ts`
- `docs/ARCHITECTURE.md`
- `docs/LOCAL_POC.md`
- `package.json`

Additional justified test-only fixes exposed by the prescribed gates:

- `apps/server/tests/event-log.test.ts`
- `apps/server/tests/runtime-app-server-container.test.ts`
- `apps/server/tests/agent-service.test.ts`
- `apps/server/tests/orchestrator-worker-prompt.test.ts`
- `apps/server/tests/projects-chats-acceptance.test.ts`

## Concerns

1. The full repository gate is not green evidence: its first test run was red and the changed-tree rerun was interrupted with the live-wave failure above. Build is therefore also unclaimed.
2. The full container pair was not rerun after the evidence-backed test-harness correction; final evidence is the initial `17/18` plus the repaired affected test `1/1`.
3. Real-provider smoke is `0/3`, explicitly skipped because bounded credentials/configuration were absent.
4. Milestone 3 lineage/pruning and skill/RLM/DCI/team/healing-time DAG evolution remain intentionally deferred.
