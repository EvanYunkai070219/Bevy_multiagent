import { spawnSync } from "node:child_process";
import { LAUNCHPAD_MCP_SERVER_SOURCE } from "../launchpad-mcp-server-source.js";
import type { RuntimeToolSchemaV1 } from "./evolution/evolution-types.js";

let cached: readonly RuntimeToolSchemaV1[] | undefined;

/** Reads the exact catalog served to Codex rather than maintaining a parallel schema list. */
export function launchpadRuntimeToolSchemas(): readonly RuntimeToolSchemaV1[] {
  if (cached !== undefined) return cached;
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    "",
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", LAUNCHPAD_MCP_SERVER_SOURCE],
    {
      encoding: "utf8",
      input,
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        LAUNCHPAD_REPAIR_CANDIDATE: "0",
      },
    },
  );
  if (result.error || result.status !== 0) return Object.freeze([]);
  for (const line of result.stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const response = JSON.parse(line) as {
        id?: unknown;
        result?: { tools?: unknown };
      };
      if (response.id !== 2 || !Array.isArray(response.result?.tools)) continue;
      const schemas = response.result.tools.map(normalizeToolSchema);
      if (schemas.some((schema) => schema === null)) return Object.freeze([]);
      cached = deepFreeze((schemas as RuntimeToolSchemaV1[])
        .sort((left, right) => left.name.localeCompare(right.name, "en")));
      return cached;
    } catch {
      return Object.freeze([]);
    }
  }
  return Object.freeze([]);
}

function normalizeToolSchema(value: unknown): RuntimeToolSchemaV1 | null {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0 ||
      typeof value.description !== "string" || !isRecord(value.inputSchema)) return null;
  try {
    const inputSchema = structuredClone(value.inputSchema);
    JSON.stringify(inputSchema);
    return {
      name: value.name,
      description: value.description,
      inputSchema,
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
