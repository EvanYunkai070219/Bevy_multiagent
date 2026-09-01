import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const scratch = process.env.SCRATCH ?? "/scratch";
const fixture = await readFile(new URL("../fixtures/held.json", import.meta.url), "utf8");
await mkdir(scratch, { recursive: true });
await writeFile(path.join(scratch, (process.env.GATE_ID ?? "held-out") + ".txt"), fixture);
