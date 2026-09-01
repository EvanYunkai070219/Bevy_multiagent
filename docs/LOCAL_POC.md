# Local POC

The local profile runs the React/Fastify control plane on macOS or Linux and
starts every Codex turn in a disposable Docker, Colima, or Podman container.
Only the Volcengine Ark model API is remote.

## Start

Requirements:

- Node.js 22+
- Docker, Colima, or Podman
- An Ark API key and Responses-capable endpoint

```bash
ARK_API_KEY=your-ark-api-key ARK_MODEL=ep-your-endpoint-id npm run poc
```

For coding against an existing repository, allow its server-local parent before
startup:

```bash
export WORKSPACE_SOURCE_ROOTS="/absolute/allowed/root"
npm run poc
```

`WORKSPACE_SOURCE_ROOTS` is a path-delimited allowlist evaluated by the server
for **Open existing folder**. Managed Projects under `AGENT_WORKSPACE_ROOT`
are always admitted; you do not need to list `workspaces/projects` here. An
`existing_repository` path therefore names a directory on the server host, not
a path on the browser's computer.

Open <http://localhost:3000>. Press `Ctrl+C` to stop the server and remove this
instance's remaining Runtime containers.

Force an engine with `CONTAINER_ENGINE=docker` or
`CONTAINER_ENGINE=podman`. Colima uses the Docker CLI.

## Data and Runtime

Persistent state defaults to:

- macOS: `~/.volc-agent-launchpad/`
- Linux: `.local/`

Set `LOCAL_POC_DATA_ROOT` to use another directory.

## Projects and Chats workflow

The sidebar groups durable work under Projects. Backend source-mode names remain
internal; the UI maps operator actions as follows:

```text
Create new project → workspaces/projects/<slug>
Open existing folder → server-local allowlisted path
New chat inside Project → inherits Project baseline
Temporary chat → legacy ephemeral workspace, excluded from Projects
```

- **Create new project** asks for a display name. The server creates
  `~/.volc-agent-launchpad/workspaces/projects/<slug>` (or under
  `LOCAL_POC_DATA_ROOT`), initializes Git with a seed commit, and publishes
  `launchpad/project/<project-id>` as the Project baseline.
- **Open existing folder** takes a path on the server host that must sit under
  `WORKSPACE_SOURCE_ROOTS`. Launchpad registers or selects the matching Project
  by Git/filesystem identity and never relocates the folder.
- **New chat** inside a Project creates a top-level Agent with that `projectId`.
  Its next Run starts from the exact durable Project `baselineCommit`.
- **Temporary chat** keeps the legacy Agent workspace under
  `workspaces/<agent-id>/` and is excluded from the Projects hierarchy.

For coding against an existing repository, allow its server-local parent before
startup (same as before):

```bash
export WORKSPACE_SOURCE_ROOTS="/absolute/allowed/root"
npm run poc
```

### Inspect Project baseline and Run branches

Do not check out Launchpad refs. Read them in place:

```bash
PROJECT_ID='<project-id-from-UI-or-API>'
PROJECT_PATH='~/.volc-agent-launchpad/workspaces/projects/<slug>'   # or external path

jq --arg project "$PROJECT_ID" \
  '.projects[] | select(.id == $project)' \
  ~/.volc-agent-launchpad/data/launchpad.json

git -C "$PROJECT_PATH" show-ref "refs/heads/launchpad/project/$PROJECT_ID"
git -C "$PROJECT_PATH" rev-parse "launchpad/project/$PROJECT_ID"
git -C "$PROJECT_PATH" status --porcelain
```

Inspect a Run without touching the user's checked-out branch:

```bash
run_branch='launchpad/run/<exact-run-id>'
final_commit='<exact-40-hex-project.headCommit>'
git -C "$PROJECT_PATH" rev-parse "$run_branch"
git -C "$PROJECT_PATH" show --stat "$final_commit"
git -C "$PROJECT_PATH" log --oneline "launchpad/project/$PROJECT_ID".."$run_branch"
git -C "$PROJECT_PATH" diff "launchpad/project/$PROJECT_ID"..."$run_branch"
```

A successful project-backed Run advances `launchpad/project/<id>` only after
verified integrations and an explicit successful task outcome. Control-loop
`completed` alone is not enough. Landing Launchpad baseline commits onto the
user's own branches remains a deliberate manual merge or cherry-pick.

## Run branches (internal source modes)

Git-backed Runs create their canonical checkout below
`<workspace-root>/.runs/<run-id>/canonical` and integrate onto
`launchpad/run/<run-id>`. With the local defaults, the workspace root is beneath
`LOCAL_POC_DATA_ROOT`; on macOS that normally means
`~/.volc-agent-launchpad/workspaces/.runs/<run-id>`. The UI reports the exact
canonical path, branch, and final commit for each Run.

Internal source modes still exist for admission:

- Project Chats inherit the Project repository (managed or external).
- Temporary Chats may use the legacy ephemeral research workspace.
- The source checkout, current branch, index, and working tree are never used
  as an integration target.

Landing is deliberately manual. After reviewing the reported branch and commit,
the user chooses whether and how to merge or cherry-pick it. The runtime never
lands changes onto the user's checked-out branch automatically.

Each turn mounts only the selected Agent workspace and Codex session directory.
Default limits are 2 CPUs, 2 GiB memory, 256 processes, dropped capabilities,
and `no-new-privileges`.

Codex requests `workspace-write`. If the Linux kernel lacks Landlock, startup
warns and disables only the inner Codex sandbox. The outer container limits
remain active, but this fallback is not tenant isolation.

## Rootless Podman on Linux

This path requires no Docker or Compose. It supports Ubuntu 22.04/24.04, Debian
12, and veLinux 2.

Install Podman:

```bash
sudo apt-get update
sudo apt-get install -y podman uidmap slirp4netns fuse-overlayfs
```

Install Node.js 22 if needed. Inspect the downloaded setup script before
running it:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x \
  -o /tmp/nodesource_setup_22.sh
less /tmp/nodesource_setup_22.sh
sudo -E bash /tmp/nodesource_setup_22.sh
sudo apt-get install -y nodejs
```

Check subordinate UID/GID ranges:

```bash
grep "^$USER:" /etc/subuid
grep "^$USER:" /etc/subgid
```

If both are missing, assign unused ranges and log in again:

```bash
sudo usermod --add-subuids 100000-165535 "$USER"
sudo usermod --add-subgids 100000-165535 "$USER"
```

Verify rootless Podman:

```bash
podman info
podman run --rm docker.io/library/alpine:3.20 echo PODMAN_OK
```

`podman info` must report `rootless: true`. Start the POC:

```bash
CONTAINER_ENGINE=podman \
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

This flow was verified on veLinux 2 with rootless Podman 4.3.1. A `vfs` storage
driver works but needs more disk space; keep at least 5 GiB free for a cold
build.

## Common options

```bash
CONTAINER_RUNTIME_APT_PACKAGES='ca-certificates curl git ripgrep python3 python3-pip python3-venv build-essential' \
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

For restricted networks, configure:

- `CONTAINER_RUNTIME_BASE_IMAGE`
- `CONTAINER_APT_MIRROR`
- `CONTAINER_APT_SECURITY_MIRROR`

Resource limits are controlled by `CONTAINER_CPU_LIMIT`,
`CONTAINER_MEMORY_LIMIT`, and `CONTAINER_PIDS_LIMIT`.

## Troubleshooting

Check Runtime readiness:

```bash
docker info                       # Or: podman info
docker image inspect volc-agent-runtime:local
curl http://localhost:3000/api/system
```

If a bind mount is rejected, set `LOCAL_POC_DATA_ROOT` to a directory shared
with the container VM. On Linux, the startup script automatically uses the host
UID/GID and validates workspace write access.

Remove only the default Runtime image:

```bash
podman image rm volc-agent-runtime:local
```

## Deterministic self-healing demo

Run the complete Milestone 2 acceptance fixture with one command:

```bash
npm run demo:self-healing
```

The command creates a temporary three-node Git project. Independent `backend`
and `frontend` workers overlap; `integration` waits for both. The backend emits
the same protected failure three times, triggering the real diagnosis,
checkpoint, one-tournament/three-candidate repair, trusted verification,
deterministic context-candidate selection, serialized integration,
post-integration verification, consumer release, and successful synthesis.

Successful output prints the complete phase trace plus run/project IDs, run
branch, real base/final/tree Git hashes, model-call and token accounting,
elapsed time, cleanup decision, and source-branch integrity. It never prints
prompts, credentials, authority contents, or local secret paths. The fixture
uses deterministic runner and verifier-container adapters while retaining the
production Agent service, live coordination endpoint, DAG scheduler, Git
worktrees, repair orchestration, evidence store, verification runner,
integration queue, lifecycle, budget, and cancellation paths.

Failure is non-zero and fail-closed. Temporary state is removed after a normal
result; on an unexpected harness exception it is preserved for diagnosis. The
automated acceptance matrix separately covers all candidates failing, consumer
regression, an expensive tie, malformed diagnosis, checkpoint failure,
authority compromise, promotion conflict, and post-gate rollback.

Real-provider smoke is intentionally opt-in and is never inferred from normal
Ark credentials. It may run only when a reviewed bounded harness config and
dedicated credentials are explicitly supplied; otherwise the smoke test is
reported as skipped.

For a failed run, inspect the append-only member trace beneath
`APP_DATA_DIR/events/<session>/<member>/trajectory.jsonl` and redacted,
content-addressed verification evidence beneath
`APP_DATA_DIR/evidence/sha256/`. The API run record carries the relevant
evidence hashes, candidate IDs, integration records, and terminal reason.

The demo and production orchestration never land code on the user's checked-out
branch. Inspect `launchpad/run/<run-id>` in the canonical run workspace and land
the verified final commit manually using the repository's normal review and
merge process. Do not merge a failed, unverified, or rolled-back run.

## Deterministic evolution-history demo

After the Milestone 2 gate is green, run:

```bash
npm run demo:self-healing-evolution
```

The command creates isolated temporary Git Projects and drives the accepted M2
production path. The first run explores all three families. An identical run
prunes only audited exact-negative families; a changed diagnosis materially
changes the fingerprint and restores exploration. The demo also reports bounded
failure capsules, `branch_pruned`/`returned_to` branch memory, an integrated
sibling, final checkpoint/head reconciliation, and a second Project receiving
zero prune or cue authority from the first Project's history.

The printed evidence includes Project/run IDs, lifecycle counts, branch-return
counts, exact-repeat and changed-run decisions, Project-isolation counts,
branch/base/head commits, sync health, dropped-history count, and user-branch
integrity. A pruned candidate was not executed and materially different
candidates execute normally. The gate also drives the production history
services with cancellation and malformed evidence; both are quarantined with
no prune, cue, or capsule. It also changes one canonical mutation fingerprint
for a trusted strategy failure: the live cue service selects one to three
advisory cues while the exact-repeat index returns no prune and no capsule.

History is logical data under `APP_DATA_DIR/evolution/projects/<project-id>/`,
not a `workspaces/` hierarchy. Evidence is content-addressed under
`APP_DATA_DIR/evidence/sha256/`. The defaults are a 1 GiB history quota, 64 KiB
per record, 1 MiB per segment, 200 records per API page, and traversal depth 4.
At corruption, missing evidence, owner conflict, quota exhaustion, or pending
outbox overflow, the UI reports unavailable/pending/quarantined truth and the
runtime falls back to the unchanged bounded Milestone 2 path.

Writing trajectory evidence is advisory to the live Milestone 2 path. If the
evidence store rejects a write, fault classification, diagnosis, and bounded
healing continue, but the fault keeps no evidence references. Historical audit
then quarantines that record as `evidence_missing`, so the failed persistence
cannot authorize later pruning, cues, or capsules.

Cancellation, restart cancellation, provider/infrastructure failures, and one
malformed or missing required evidence reference exclude the whole historical
record from pruning, cues, and mutation-quality capsules. The Evolution panel
lives inside the selected run after its summary; `View branch history` is
collapsed initially and never implies that M3 ranked or executed a branch.

The demo owns every temporary store and coordination server and closes them
idempotently. It exits through normal promise settlement; no forced exit is used.
Detailed history remains Project-local. A future audited global harness catalog
is a separate promotion authority and cannot ingest raw Project evidence.

The panel's “historical evidence” count is separate from current declared,
pruned, admitted, executed, verified, promoted, and rolled-back counts. A
pruned candidate was not executed. Cue transfer values (`helped`, `neutral`,
`regressed`, `inconclusive`) describe later natural trials only; they do not
change live ranking or start replay work.

Skill synthesis/promotion, semantic strategy learning, RLM, DCI, dynamic team
sizing, active transfer experiments, and healing-time DAG mutation are not
enabled by this demo or Milestone 3.
