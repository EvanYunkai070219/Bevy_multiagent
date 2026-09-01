import { access, mkdir, rename } from "node:fs/promises";
import path from "node:path";

export interface ServerDataPaths {
  database: string;
  eventLog: string;
  sharedRuns: string;
  teamRuns: string;
  toolState: string;
  containerAuthority: string;
}

export function serverDataPaths(dataDirectory: string): ServerDataPaths {
  return {
    database: path.join(dataDirectory, "db", "launchpad.json"),
    eventLog: path.join(dataDirectory, "runs", "events"),
    sharedRuns: path.join(dataDirectory, "runs", "shared"),
    teamRuns: path.join(dataDirectory, "runs", "team"),
    toolState: path.join(dataDirectory, "runs", "tool-state"),
    containerAuthority: path.join(dataDirectory, "runtime", "container-authority"),
  };
}

export async function migrateServerDataLayout(dataDirectory: string): Promise<void> {
  const paths = serverDataPaths(dataDirectory);
  await moveIfTargetMissing(path.join(dataDirectory, "launchpad.json"), paths.database);
  await moveIfTargetMissing(path.join(dataDirectory, "event"), paths.eventLog);
  await moveIfTargetMissing(path.join(dataDirectory, "shared"), paths.sharedRuns);
  await moveIfTargetMissing(path.join(dataDirectory, "team"), paths.teamRuns);
  await moveIfTargetMissing(path.join(dataDirectory, "tool-state"), paths.toolState);
  await moveIfTargetMissing(
    path.join(dataDirectory, "container-authority"),
    paths.containerAuthority,
  );
}

async function moveIfTargetMissing(source: string, target: string): Promise<void> {
  if (!(await exists(source)) || await exists(target)) return;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await rename(source, target);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
