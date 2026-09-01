import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { GitClient } from "../src/git-client.js";
import { EvidenceStore } from "../src/orchestration/verification/evidence-store.js";
import { VerificationContainer } from "../src/orchestration/verification/verification-container.js";
import { VerificationProfileRegistry } from "../src/orchestration/verification/verification-profile.js";
import { VerificationRunner } from "../src/orchestration/verification/verifier.js";
import { materializeAuthority } from "./verification-authority-fixtures.js";

export interface FakeVerifierEngineBehavior {
  log?: string;
  envLog?: string;
  runCid?: string;
  gateExitCode?: number;
  engineExitCode?: number;
  engineSignal?: "TERM";
  completionArtifact?:
    | "valid"
    | "missing"
    | "malformed"
    | "missing_field"
    | "extra_field"
    | "wrong_version"
    | "wrong_nonce"
    | "wrong_exit"
    | "invalid_exit"
    | "wrong_mode"
    | "symlink"
    | "trailing"
    | "request_retained"
    | "temp_retained";
  requestCopyFails?: boolean;
  artifactCopyFails?: boolean;
  inspectFailsOnceAt?: "created" | "exited";
  startFails?: boolean;
  completionMountMutation?: "wrong_type" | "read_only" | "invalid_name" | "changed_after_start";
  createReady?: string;
  createPid?: string;
  createOverlapMarker?: string;
  createDelaySeconds?: number;
  createIgnoresTermination?: boolean;
  createCommittedReady?: string;
  createHoldAfterSuccessSeconds?: number;
  createDaemonAfterTermination?: boolean;
  createTransportExitsBeforeDaemonCommit?: boolean;
  createTransportExitCode?: number;
  createNeverSettles?: boolean;
  createCommitMarker?: string;
  createDaemonDelayMs?: number;
  inspectDelaySeconds?: number;
  inspectDelayAt?: "created" | "exited";
  inspectDelayOnce?: boolean;
  inspectOutputBytes?: number;
  inspectOutputAt?: "created" | "exited";
  inspectOutputOnce?: boolean;
  artifactCopyReady?: string;
  artifactCopyRelease?: string;
  runStdout?: string;
  runStderr?: string;
  inspectOwnerId?: string;
  removeFails?: boolean;
  firstRemoveFails?: boolean;
  removeReady?: string;
  removeReadyAttempt?: number;
  removeDelaySeconds?: number;
  firstRemoveDelaySeconds?: number;
  runReady?: string;
  runPid?: string;
  runIgnoresTermination?: boolean;
  runOutputRelease?: string;
  runExitBeforeCloseDelayMs?: number;
  runDelaySeconds?: number;
  volumeInspectReady?: string;
  volumeInspectReadyAttempt?: number;
  volumeInspectRelease?: string;
  volumeInspectPid?: string;
  volumeInspectPidDelaySeconds?: number;
  volumeCreateDelaySeconds?: number;
  volumeInspectMutationAt?: number;
  volumeInspectMutation?: "missing" | "replaced" | "unlabelled" | "auto_created";
}

export async function fakeVerifierEngine(
  root: string,
  behavior: FakeVerifierEngineBehavior = {},
): Promise<string> {
  const engine = path.join(root, "fake-verifier-engine");
  const state = path.join(root, "removed");
  const cidState = path.join(root, "cid-written");
  const ownerFile = path.join(root, "owner-id");
  const stdoutFile = path.join(root, "run-stdout");
  const stderrFile = path.join(root, "run-stderr");
  const completionWriter = path.join(root, "fake-verifier-completion.mjs");
  const lateCreateWriter = path.join(root, "fake-verifier-late-create.mjs");
  const streamHolderWriter = path.join(root, "fake-verifier-stream-holder.mjs");
  const lateCreateTrigger = path.join(root, "fake-verifier-late-create.trigger");
  const lateCreateCancel = path.join(root, "fake-verifier-late-create.cancel");
  const lateCreateRequest = path.join(root, "fake-verifier-late-create.request");
  const containerRequest = path.join(root, "container-request.json");
  const containerArtifact = path.join(root, "container-completion.json");
  const containerArtifactTarget = path.join(root, "container-completion-target.json");
  const containerTemporary = path.join(root, "container-completion.tmp");
  const lifecycleState = path.join(root, "container-lifecycle");
  const inspectFailed = path.join(root, "inspect-failed");
  const inspectDelayed = path.join(root, "inspect-delayed");
  const inspectOversized = path.join(root, "inspect-oversized");
  const removeCountFile = path.join(root, "remove-count");
  const volumeInspectCountFile = path.join(root, "volume-inspect-count");
  const volumeState = path.join(root, "volume-created");
  const volumeNameFile = path.join(root, "volume-name");
  const volumeOwnerFile = path.join(root, "volume-owner-id");
  const runCid = behavior.runCid ?? "c".repeat(64);
  const completionVolume = "f".repeat(64);
  const completionMountType = behavior.completionMountMutation === "wrong_type" ? "bind" : "volume";
  const completionMountWritable = behavior.completionMountMutation === "read_only" ? "false" : "true";
  const engineExitCode = behavior.engineExitCode ?? (behavior.gateExitCode === undefined || behavior.gateExitCode === 0
    ? 200
    : 201);
  const completionArtifact = behavior.completionArtifact ?? "valid";
  const artifactExitCode = behavior.gateExitCode === undefined || behavior.gateExitCode === 0 ? 0 : 1;
  await writeFile(stdoutFile, behavior.runStdout ?? "ok\n", "utf8");
  await writeFile(stderrFile, behavior.runStderr ?? "", "utf8");
  await writeFile(completionWriter, `
import { chmod, readFile, symlink, unlink, writeFile } from "node:fs/promises";
const [requestPath, artifactPath, targetPath, temporaryPath, behavior, requestedExit] = process.argv.slice(2);
if (behavior === "missing") process.exit(0);
const request = JSON.parse(await readFile(requestPath, "utf8"));
if (behavior !== "request_retained") await unlink(requestPath);
let exitCode = Number(requestedExit);
let nonce = request.nonce;
let schemaVersion = 1;
if (behavior === "wrong_exit") exitCode = exitCode === 0 ? 1 : 0;
if (behavior === "wrong_nonce") nonce = "0".repeat(64);
if (behavior === "wrong_version") schemaVersion = 2;
let contents = JSON.stringify({ schemaVersion, nonce, exitCode }) + "\\n";
if (behavior === "malformed") contents = "{not-json}\\n";
if (behavior === "missing_field") contents = JSON.stringify({ schemaVersion, nonce }) + "\\n";
if (behavior === "extra_field") contents = JSON.stringify({ schemaVersion, nonce, exitCode, extra: true }) + "\\n";
if (behavior === "invalid_exit") contents = JSON.stringify({ schemaVersion, nonce, exitCode: 2 }) + "\\n";
if (behavior === "trailing") contents += "trailing-bytes";
if (behavior === "symlink") {
  await writeFile(targetPath, contents, { mode: 0o600 });
  await symlink(targetPath, artifactPath);
} else {
  await writeFile(artifactPath, contents, { flag: "wx", mode: 0o600 });
  if (behavior === "wrong_mode") await chmod(artifactPath, 0o644);
}
if (behavior === "temp_retained") await writeFile(temporaryPath, "partial", { mode: 0o600 });
`, "utf8");
  await writeFile(lateCreateWriter, `
import { access, readFile, writeFile } from "node:fs/promises";
const [fixtureRoot, triggerPath, cancelPath, requestPath] = process.argv.slice(2);
const exists = (target) => access(target).then(() => true).catch(() => false);
while (!(await exists(triggerPath))) {
  if (await exists(cancelPath)) process.exit(0);
  if (!(await exists(fixtureRoot))) process.exit(0);
  await new Promise((resolve) => setTimeout(resolve, 10));
}
while (!(await exists(requestPath))) {
  if (!(await exists(fixtureRoot))) process.exit(0);
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const cidFile = (await readFile(requestPath, "utf8")).trim();
await new Promise((resolve) => setTimeout(resolve, ${JSON.stringify(behavior.createDaemonDelayMs ?? 200)}));
await writeFile(cidFile, ${JSON.stringify(runCid + "\n")}, "utf8");
await writeFile(${JSON.stringify(cidState)}, "", "utf8");
await writeFile(${JSON.stringify(lifecycleState)}, "created\\n", "utf8");
if (${JSON.stringify(behavior.createCommitMarker ?? "")} !== "") {
  await writeFile(${JSON.stringify(behavior.createCommitMarker ?? "/dev/null")}, "committed\\n", "utf8");
}
`, "utf8");
  await writeFile(streamHolderWriter, `
import { spawn } from "node:child_process";
const delay = Number(process.argv[2]);
const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, " + JSON.stringify(delay) + ")"], {
  detached: true,
  stdio: ["ignore", 1, 2],
});
holder.unref();
`, "utf8");
  const source = `#!/bin/sh
set -eu
if [ -n ${JSON.stringify(behavior.envLog ?? "")} ]; then
  env >> ${JSON.stringify(behavior.envLog ?? "/dev/null")}
fi
printf '%s\\n' "$*" >> ${JSON.stringify(behavior.log ?? path.join(root, "commands.log"))}
if [ "$1" != "create" ] && [ -n ${JSON.stringify(behavior.createOverlapMarker ?? "")} ] && [ -f ${JSON.stringify(behavior.createPid ?? "/dev/null")} ]; then
  create_pid=$(cat ${JSON.stringify(behavior.createPid ?? "/dev/null")})
  if kill -0 "$create_pid" 2>/dev/null; then : > ${JSON.stringify(behavior.createOverlapMarker ?? "/dev/null")}; fi
fi
if [ "$1" = "create" ]; then
  rm -f ${JSON.stringify(state)}
  rm -f ${JSON.stringify(inspectFailed)} ${JSON.stringify(inspectDelayed)} ${JSON.stringify(inspectOversized)} ${JSON.stringify(containerRequest)} ${JSON.stringify(containerArtifact)} ${JSON.stringify(containerArtifactTarget)} ${JSON.stringify(containerTemporary)}
  cidfile=""
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--cidfile" ]; then cidfile="$arg"; fi
    case "$arg" in
      io.codejam.owner-id=*) printf '%s\\n' "\${arg#io.codejam.owner-id=}" > ${JSON.stringify(ownerFile)} ;;
      type=volume,src=*,dst=/run/launchpad-result,*)
        volume_mount="\${arg#type=volume,src=}"
        printf '%s\\n' "\${volume_mount%%,*}" > ${JSON.stringify(volumeNameFile)}
        ;;
    esac
    prev="$arg"
  done
  if [ ${JSON.stringify(behavior.createDaemonAfterTermination || behavior.createTransportExitsBeforeDaemonCommit ? "1" : "0")} = "1" ]; then printf '%s\\n' "$cidfile" > ${JSON.stringify(lateCreateRequest)}; fi
  if [ -n ${JSON.stringify(behavior.createPid ?? "")} ]; then printf '%s\\n' "$$" > ${JSON.stringify(behavior.createPid ?? "/dev/null")}; fi
  if [ -n ${JSON.stringify(behavior.createReady ?? "")} ]; then : > ${JSON.stringify(behavior.createReady ?? "/dev/null")}; fi
  if [ ${JSON.stringify(behavior.createTransportExitsBeforeDaemonCommit ? "1" : "0")} = "1" ]; then
    : > ${JSON.stringify(lateCreateTrigger)}
    exit ${JSON.stringify(behavior.createTransportExitCode ?? 125)}
  fi
  if [ ${JSON.stringify(behavior.createDaemonAfterTermination ? "1" : "0")} = "1" ]; then
    trap ': > ${JSON.stringify(lateCreateTrigger)}; exit 143' HUP INT TERM
  elif [ ${JSON.stringify(behavior.createIgnoresTermination ? "1" : "0")} = "1" ]; then
    trap '' HUP INT TERM
  fi
  if [ ${JSON.stringify(behavior.createNeverSettles ? "1" : "0")} = "1" ]; then
    while :; do sleep 1; done
  fi
  create_delay=${JSON.stringify(behavior.createDelaySeconds ?? 0)}
  if [ "$create_delay" != "0" ]; then sleep "$create_delay"; fi
  if [ -n "$cidfile" ]; then printf '%s\\n' ${JSON.stringify(runCid)} > "$cidfile"; fi
  : > ${JSON.stringify(cidState)}
  printf '%s\\n' created > ${JSON.stringify(lifecycleState)}
  if [ -n ${JSON.stringify(behavior.createCommitMarker ?? "")} ]; then : > ${JSON.stringify(behavior.createCommitMarker ?? "/dev/null")}; fi
  if [ ${JSON.stringify(behavior.createDaemonAfterTermination ? "1" : "0")} = "1" ]; then : > ${JSON.stringify(lateCreateCancel)}; fi
  if [ -n ${JSON.stringify(behavior.createCommittedReady ?? "")} ]; then : > ${JSON.stringify(behavior.createCommittedReady ?? "/dev/null")}; fi
  create_hold=${JSON.stringify(behavior.createHoldAfterSuccessSeconds ?? 0)}
  if [ "$create_hold" != "0" ]; then sleep "$create_hold"; fi
  printf '%s\\n' ${JSON.stringify(runCid)}
  exit 0
fi
if [ "$1" = "cp" ]; then
  case "$2" in
    *:/run/launchpad-result/completion.json)
      if [ ${JSON.stringify(behavior.artifactCopyFails ? "1" : "0")} = "1" ]; then exit 1; fi
      if [ ! -e ${JSON.stringify(containerArtifact)} ] && [ ! -L ${JSON.stringify(containerArtifact)} ]; then exit 1; fi
      cp -P ${JSON.stringify(containerArtifact)} "$3"
      destination_directory=$(dirname "$3")
      if [ ${JSON.stringify(completionArtifact)} = "request_retained" ]; then
        cp ${JSON.stringify(containerRequest)} "$destination_directory/request.json"
      fi
      if [ ${JSON.stringify(completionArtifact)} = "temp_retained" ]; then
        cp ${JSON.stringify(containerTemporary)} "$destination_directory/.completion.tmp"
      fi
      if [ -n ${JSON.stringify(behavior.artifactCopyReady ?? "")} ]; then : > ${JSON.stringify(behavior.artifactCopyReady ?? "/dev/null")}; fi
      if [ -n ${JSON.stringify(behavior.artifactCopyRelease ?? "")} ]; then
        while [ ! -f ${JSON.stringify(behavior.artifactCopyRelease ?? "/dev/null")} ]; do sleep 0.01; done
      fi
      exit 0
      ;;
    *)
      if [ ${JSON.stringify(behavior.requestCopyFails ? "1" : "0")} = "1" ]; then exit 1; fi
      if [ "$2" = "-" ]; then
        tar -xOf - request.json > ${JSON.stringify(containerRequest)}
      else
        cp "$2" ${JSON.stringify(containerRequest)}
      fi
      exit 0
      ;;
  esac
fi
if [ "$1" = "start" ]; then
  if [ -n ${JSON.stringify(behavior.runPid ?? "")} ]; then printf '%s\\n' "$$" > ${JSON.stringify(behavior.runPid ?? "/dev/null")}; fi
  if [ ${JSON.stringify(behavior.runIgnoresTermination ? "1" : "0")} = "1" ]; then trap '' HUP INT TERM; fi
  if [ ${JSON.stringify((behavior.runExitBeforeCloseDelayMs ?? 0) > 0 ? "1" : "0")} = "1" ]; then
    node ${JSON.stringify(streamHolderWriter)} ${JSON.stringify(behavior.runExitBeforeCloseDelayMs ?? 0)}
  fi
  if [ -n ${JSON.stringify(behavior.runReady ?? "")} ]; then : > ${JSON.stringify(behavior.runReady ?? "/dev/null")}; fi
  if [ -n ${JSON.stringify(behavior.runOutputRelease ?? "")} ]; then
    while [ ! -f ${JSON.stringify(behavior.runOutputRelease ?? "/dev/null")} ]; do true; done
  fi
  if [ ${JSON.stringify(behavior.runDelaySeconds ?? 0)} -gt 0 ]; then sleep ${JSON.stringify(behavior.runDelaySeconds ?? 0)}; fi
  cat ${JSON.stringify(stdoutFile)}
  cat ${JSON.stringify(stderrFile)} >&2
  if [ ${JSON.stringify(behavior.startFails ? "1" : "0")} = "1" ]; then
    printf '%s\\n' exited > ${JSON.stringify(lifecycleState)}
    exit 125
  fi
  node ${JSON.stringify(completionWriter)} ${JSON.stringify(containerRequest)} ${JSON.stringify(containerArtifact)} ${JSON.stringify(containerArtifactTarget)} ${JSON.stringify(containerTemporary)} ${JSON.stringify(completionArtifact)} ${JSON.stringify(String(artifactExitCode))}
  printf '%s\\n' exited > ${JSON.stringify(lifecycleState)}
  if [ -n ${JSON.stringify(behavior.engineSignal ?? "")} ]; then
    kill -s ${JSON.stringify(behavior.engineSignal ?? "TERM")} "$$"
    sleep 1
    exit 255
  fi
  exit ${JSON.stringify(engineExitCode)}
fi
if [ "$1" = "rm" ]; then
  remove_count=0
  if [ -f ${JSON.stringify(removeCountFile)} ]; then remove_count=$(cat ${JSON.stringify(removeCountFile)}); fi
  remove_count=$((remove_count + 1))
  printf '%s\\n' "$remove_count" > ${JSON.stringify(removeCountFile)}
  if [ -n ${JSON.stringify(behavior.removeReady ?? "")} ] && [ "$remove_count" -eq ${JSON.stringify(behavior.removeReadyAttempt ?? 1)} ]; then : > ${JSON.stringify(behavior.removeReady ?? "/dev/null")}; fi
  remove_delay=${JSON.stringify(behavior.removeDelaySeconds ?? 0)}
  if [ "$remove_count" -eq 1 ]; then remove_delay=${JSON.stringify(behavior.firstRemoveDelaySeconds ?? behavior.removeDelaySeconds ?? 0)}; fi
  if [ "$remove_delay" -gt 0 ]; then sleep "$remove_delay"; fi
  if [ "$remove_count" -eq 1 ] && [ ${JSON.stringify(behavior.firstRemoveFails ? "1" : "0")} = "1" ]; then exit 1; fi
  if [ ${JSON.stringify(behavior.removeFails ? "1" : "0")} = "1" ]; then exit 1; fi
  : > ${JSON.stringify(state)}
  exit 0
fi
if [ "$1" = "volume" ] && [ "$2" = "create" ]; then
  volume_name=""
  volume_owner=""
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--label" ]; then
      case "$arg" in io.codejam.owner-id=*) volume_owner="\${arg#io.codejam.owner-id=}" ;; esac
    fi
    volume_name="$arg"
    prev="$arg"
  done
  volume_create_delay=${JSON.stringify(behavior.volumeCreateDelaySeconds ?? 0)}
  if [ "$volume_create_delay" != "0" ]; then sleep "$volume_create_delay"; fi
  printf '%s\\n' "$volume_name" > ${JSON.stringify(volumeNameFile)}
  printf '%s\\n' "$volume_owner" > ${JSON.stringify(volumeOwnerFile)}
  : > ${JSON.stringify(volumeState)}
  printf '%s\\n' "$volume_name"
  exit 0
fi
if [ "$1" = "volume" ] && [ "$2" = "inspect" ]; then
  volume_inspect_count=0
  if [ -f ${JSON.stringify(volumeInspectCountFile)} ]; then volume_inspect_count=$(cat ${JSON.stringify(volumeInspectCountFile)}); fi
  volume_inspect_count=$((volume_inspect_count + 1))
  printf '%s\\n' "$volume_inspect_count" > ${JSON.stringify(volumeInspectCountFile)}
  if [ -n ${JSON.stringify(behavior.volumeInspectReady ?? "")} ] && [ "$volume_inspect_count" -eq ${JSON.stringify(behavior.volumeInspectReadyAttempt ?? 1)} ]; then
    : > ${JSON.stringify(behavior.volumeInspectReady ?? "/dev/null")}
  fi
  if [ -n ${JSON.stringify(behavior.volumeInspectPid ?? "")} ]; then
    volume_inspect_pid_delay=${JSON.stringify(behavior.volumeInspectPidDelaySeconds ?? 0)}
    if [ "$volume_inspect_pid_delay" != "0" ]; then sleep "$volume_inspect_pid_delay"; fi
    printf '%s\\n' "$$" > ${JSON.stringify(behavior.volumeInspectPid ?? "/dev/null")}
  fi
  if [ -n ${JSON.stringify(behavior.volumeInspectReady ?? "")} ] && [ "$volume_inspect_count" -eq ${JSON.stringify(behavior.volumeInspectReadyAttempt ?? 1)} ]; then
    if [ -n ${JSON.stringify(behavior.volumeInspectRelease ?? "")} ]; then
      while [ ! -f ${JSON.stringify(behavior.volumeInspectRelease ?? "/dev/null")} ]; do sleep 0.01; done
    fi
  fi
  volume_mutation=""
  if [ "$volume_inspect_count" -eq ${JSON.stringify(behavior.volumeInspectMutationAt ?? 0)} ]; then
    volume_mutation=${JSON.stringify(behavior.volumeInspectMutation ?? "")}
  fi
  if [ "$volume_mutation" = "missing" ]; then rm -f ${JSON.stringify(volumeState)}; fi
  if [ -f ${JSON.stringify(volumeState)} ] && [ -f ${JSON.stringify(volumeNameFile)} ] && [ "$(cat ${JSON.stringify(volumeNameFile)})" = "$5" ]; then
    volume_owner=""
    if [ -f ${JSON.stringify(volumeOwnerFile)} ]; then volume_owner=$(cat ${JSON.stringify(volumeOwnerFile)}); fi
    if [ "$volume_mutation" = "auto_created" ]; then
      printf '{"Name":"%s","Driver":"local","Mountpoint":"/fake/auto-created","CreatedAt":"2026-08-30T00:00:01Z","Scope":"local","Labels":null,"Options":null}\\n' "$5"
    elif [ "$volume_mutation" = "unlabelled" ]; then
      printf '{"Name":"%s","Driver":"local","Mountpoint":"/fake/unlabelled","CreatedAt":"2026-08-30T00:00:01Z","Scope":"local","Labels":{},"Options":null}\\n' "$5"
    elif [ "$volume_mutation" = "replaced" ]; then
      printf '{"Name":"%s","Driver":"local","Mountpoint":"/fake/replaced","CreatedAt":"2026-08-30T00:00:01Z","Scope":"local","Labels":{"io.codejam.owner-id":"%s"},"Options":null}\\n' "$5" "$volume_owner"
    else
      printf '{"Name":"%s","Driver":"local","Mountpoint":"/fake/original","CreatedAt":"2026-08-30T00:00:00Z","Scope":"local","Labels":{"io.codejam.owner-id":"%s"},"Options":null}\\n' "$5" "$volume_owner"
    fi
    exit 0
  fi
  echo "Error response from daemon: get $5: no such volume" >&2
  exit 1
fi
if [ "$1" = "volume" ] && [ "$2" = "rm" ]; then
  if [ -f ${JSON.stringify(volumeState)} ] && [ -f ${JSON.stringify(volumeNameFile)} ] && [ "$(cat ${JSON.stringify(volumeNameFile)})" = "$3" ]; then
    rm -f ${JSON.stringify(volumeState)}
    printf '%s\\n' "$3"
    exit 0
  fi
  echo "Error response from daemon: get $3: no such volume" >&2
  exit 1
fi
if [ -f ${JSON.stringify(state)} ]; then
  echo "Error: No such container: $5" >&2
  exit 1
fi
if [ -f ${JSON.stringify(cidState)} ]; then
  lifecycle=$(cat ${JSON.stringify(lifecycleState)})
  if [ "$lifecycle" = ${JSON.stringify(behavior.inspectDelayAt ?? "never")} ] && { [ ${JSON.stringify(behavior.inspectDelayOnce ? "1" : "0")} = "0" ] || [ ! -f ${JSON.stringify(inspectDelayed)} ]; }; then
    : > ${JSON.stringify(inspectDelayed)}
    inspect_delay=${JSON.stringify(behavior.inspectDelaySeconds ?? 0)}
    if [ "$inspect_delay" != "0" ]; then sleep "$inspect_delay"; fi
  fi
  if [ -n ${JSON.stringify(behavior.inspectFailsOnceAt ?? "")} ] && [ "$lifecycle" = ${JSON.stringify(behavior.inspectFailsOnceAt ?? "never")} ] && [ ! -f ${JSON.stringify(inspectFailed)} ]; then
    : > ${JSON.stringify(inspectFailed)}
    echo "permission denied" >&2
    exit 1
  fi
  owner=$(cat ${JSON.stringify(ownerFile)})
  if [ -n ${JSON.stringify(behavior.inspectOwnerId ?? "")} ]; then owner=${JSON.stringify(behavior.inspectOwnerId ?? "")}; fi
  exit_code=0
  if [ "$lifecycle" = "exited" ]; then exit_code=${JSON.stringify(engineExitCode)}; fi
  volume_name=${JSON.stringify(completionVolume)}
  if [ -f ${JSON.stringify(volumeNameFile)} ]; then volume_name=$(cat ${JSON.stringify(volumeNameFile)}); fi
  if [ ${JSON.stringify(behavior.completionMountMutation === "invalid_name" ? "1" : "0")} = "1" ]; then volume_name="not-exact"; fi
  if [ "$lifecycle" = "exited" ] && [ ${JSON.stringify(behavior.completionMountMutation === "changed_after_start" ? "1" : "0")} = "1" ]; then volume_name=${JSON.stringify("e".repeat(64))}; fi
  inspect_padding=""
  if [ "$lifecycle" = ${JSON.stringify(behavior.inspectOutputAt ?? "never")} ] && { [ ${JSON.stringify(behavior.inspectOutputOnce ? "1" : "0")} = "0" ] || [ ! -f ${JSON.stringify(inspectOversized)} ]; }; then
    : > ${JSON.stringify(inspectOversized)}
    inspect_padding=${JSON.stringify("x".repeat(behavior.inspectOutputBytes ?? 0))}
  fi
  printf '{"Id":"%s","Config":{"Labels":{"io.codejam.owner-id":"%s"}},"State":{"Status":"%s","Running":false,"ExitCode":%s},"Mounts":[{"Type":"%s","Name":"%s","Destination":"/run/launchpad-result","RW":%s}],"Padding":"%s"}\\n' ${JSON.stringify(runCid)} "$owner" "$lifecycle" "$exit_code" ${JSON.stringify(completionMountType)} "$volume_name" ${JSON.stringify(completionMountWritable)} "$inspect_padding"
  exit 0
fi
echo "Error: No such container: $5" >&2
exit 1
`;
  await writeFile(engine, source);
  await chmod(engine, 0o700);
  if (behavior.createDaemonAfterTermination || behavior.createTransportExitsBeforeDaemonCommit) {
    const daemon = spawn(process.execPath, [
      lateCreateWriter,
      root,
      lateCreateTrigger,
      lateCreateCancel,
      lateCreateRequest,
    ], {
      detached: true,
      stdio: "ignore",
    });
    daemon.unref();
  }
  return engine;
}

export async function realVerificationFixture(input: {
  root: string;
  engine?: string;
  behavior?: FakeVerifierEngineBehavior;
  config?: Record<string, string>;
}) {
  const authorityRoot = path.join(input.root, "authority");
  const workspace = path.join(input.root, "candidate");
  const dataDirectory = path.join(input.root, "data");
  const engine = input.engine ?? await fakeVerifierEngine(input.root, input.behavior);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(path.join(workspace, "src", "app.ts"), "export const ok = true;\n", "utf8");
  const profilePath = await materializeAuthority(authorityRoot);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: dataDirectory,
    CONTAINER_ENGINE: engine,
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...input.config,
  });
  const registry = new VerificationProfileRegistry({
    profilePath,
    workspaceRoot: path.join(input.root, "workspaces"),
    workspaceSourceRoots: [path.join(input.root, "sources")],
    eventSessionRoot: path.join(input.root, "event"),
    projectRepositories: [],
    runsDirectories: [path.join(input.root, ".runs")],
  });
  await Promise.all([
    mkdir(path.join(input.root, "workspaces"), { recursive: true }),
    mkdir(path.join(input.root, "sources"), { recursive: true }),
    mkdir(path.join(input.root, "event"), { recursive: true }),
    mkdir(path.join(input.root, ".runs"), { recursive: true }),
  ]);
  await registry.load();
  const store = new EvidenceStore({ dataDirectory, secrets: [] });
  const git = new GitClient(5_000);
  await git.run(workspace, ["init", "-b", "main"]);
  await git.run(workspace, ["config", "user.name", "Test"]);
  await git.run(workspace, ["config", "user.email", "test@example.invalid"]);
  await git.run(workspace, ["add", "--", "src/app.ts"]);
  await git.run(workspace, ["commit", "-m", "base"]);
  const baseCommit = await git.head(workspace);
  const container = new VerificationContainer(config);
  const runner = new VerificationRunner({ registry, container, store, git });
  return { authorityRoot, baseCommit, config, container, registry, runner, workspace };
}
