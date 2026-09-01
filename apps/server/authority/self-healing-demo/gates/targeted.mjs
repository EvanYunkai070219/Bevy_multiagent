import { helper } from "../helpers/lib.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const scratch = process.env.SCRATCH ?? "/scratch";
await mkdir(scratch, { recursive: true });
await writeFile(path.join(scratch, (process.env.GATE_ID ?? "targeted") + ".txt"), String(helper) + "\n");
