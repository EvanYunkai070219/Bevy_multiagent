import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FORBIDDEN_LEADER_CONTRACT_KEYS } from "../src/types.js";
import { LAUNCHPAD_MCP_SERVER_SOURCE } from "../src/launchpad-mcp-server-source.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Launchpad MCP server", () => {
  it("lists and calls the local orchestration tools", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-mcp-test-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const data = path.join(root, "data");
    const serverPath = path.join(root, "launchpad-mcp-server.mjs");
    await writeFile(serverPath, LAUNCHPAD_MCP_SERVER_SOURCE, "utf8");
    await writeFile(path.join(workspace, "note.txt"), "alpha beta gamma", {
      flag: "wx",
    }).catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(workspace, { recursive: true });
      await writeFile(path.join(workspace, "note.txt"), "alpha beta gamma");
    });

    const server = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        LAUNCHPAD_WORKSPACE_PATH: workspace,
        LAUNCHPAD_DATA_DIR: data,
        LAUNCHPAD_AGENT_ID: "agent-1",
        LAUNCHPAD_RUN_ID: "run-1",
        LAUNCHPAD_PARENT_RUN_ID: "leader-1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = jsonRpcClient(server);
    try {
      await client.call("initialize", { protocolVersion: "2024-11-05" });
      const listed = await client.call("tools/list", {});
      expect(listed.tools.map((tool: { name: string }) => tool.name)).toEqual(
        expect.arrayContaining([
          "web_search",
          "fetch_webpage",
          "publish_artifact",
          "list_artifacts",
          "read_artifact",
          "dispatch_subagent",
          "wait_for_workers",
          "inspect_worker_progress",
          "extend_worker_timeout",
          "register_custom_tool",
          "list_custom_tools",
          "call_custom_tool",
          "bootstrap_context",
          "whiteboard_post",
          "whiteboard_read",
          "view_task",
          "claim_task",
          "submit_plan",
          "complete_task",
          "report_progress",
          "list_files",
          "search_files",
          "read_file",
          "read_many_files",
          "validate_skill",
          "publish_skill",
          "search_skills",
          "read_skill",
          "install_skill",
          "search_skill_wiki",
          "read_skill_wiki",
          "update_skill_wiki",
          "stage_skill_proposal",
          "read_skill_proposal",
          "list_skill_proposals",
          "finalize_skill_proposal",
          "record_skill_impact",
          "search_run_events",
          "read_worker_log",
          "summarize_worker_trace",
          "browser_open",
          "browser_snapshot",
          "browser_click",
          "browser_type",
          "browser_screenshot",
          "tool_search",
          "tool_call",
          "batch_tool_call",
          "start_job",
          "list_jobs",
          "cancel_job",
          "read_job_output",
          "wait_job",
          "loop_status",
        ]),
      );
      expect(JSON.stringify(listed).length).toBeLessThan(22_000);
      expect(JSON.stringify(listed)).not.toContain('"description":"Path to');
      const resources = await client.call("resources/list", {});
      expect(
        resources.resources.map((resource: { uri: string }) => resource.uri),
      ).toEqual(
        expect.arrayContaining([
          "launchpad://context",
          "launchpad://tools",
          "launchpad://custom-tools",
          "launchpad://skills",
          "launchpad://skill-wiki",
          "launchpad://whiteboard",
          "launchpad://artifacts",
        ]),
      );
      const catalog = await client.call("resources/read", {
        uri: "launchpad://tools",
      });
      expect(catalog.contents[0].text).toContain("read_file");

      const file = await client.call("tools/call", {
        name: "read_file",
        arguments: { path: "note.txt" },
      });
      expect(file.content[0].text).toContain("alpha beta gamma");

      const artifact = await client.call("tools/call", {
        name: "publish_artifact",
        arguments: { text: "artifact body", description: "demo" },
      });
      const artifactBody = JSON.parse(artifact.content[0].text);
      expect(artifactBody.artifact.ownerWorkerRunId).toBe("run-1");

      const discovered = await client.call("tools/call", {
        name: "tool_search",
        arguments: { query: "artifact", limit: 3 },
      });
      expect(discovered.content[0].text).toContain("publish_artifact");

      const batch = await client.call("tools/call", {
        name: "batch_tool_call",
        arguments: {
          parallel: true,
          calls: [
            { tool_name: "list_files", arguments: { max_entries: 5 } },
            { tool_name: "read_file", arguments: { path: "note.txt" } },
          ],
        },
      });
      const batchBody = JSON.parse(batch.content[0].text);
      expect(batchBody.ok).toBe(true);
      expect(batchBody.parallel).toBe(true);
      expect(batchBody.results.map((item: { tool: string }) => item.tool)).toEqual([
        "list_files",
        "read_file",
      ]);
      expect(batch.content[0].text).toContain("alpha beta gamma");

      const loop = JSON.parse(
        (await client.call("tools/call", { name: "loop_status", arguments: {} })).content[0].text,
      );
      expect(loop.ok).toBe(true);
      expect(loop.observational).toBe(true);
      expect(loop.authorizesContinuation).toBe(false);
    } finally {
      server.kill("SIGTERM");
    }
  });

  it("keeps batch tool failures local to the failed call", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-mcp-batch-failure-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const worker = await spawnWorker(root, data, "run-a", "leader-1");
    try {
      const batch = await worker.client.call("tools/call", {
        name: "batch_tool_call",
        arguments: {
          calls: [
            { tool_name: "list_artifacts", arguments: {} },
            { tool_name: "missing_tool", arguments: {} },
          ],
        },
      });
      const body = JSON.parse(batch.content[0].text);
      expect(batch.isError).toBe(false);
      expect(body.ok).toBe(true);
      expect(body.all_ok).toBe(false);
      expect(body.failed_count).toBe(1);
      expect(body.results[0]).toMatchObject({ tool: "list_artifacts", ok: true });
      expect(body.results[1]).toMatchObject({ tool: "missing_tool", ok: false });
    } finally {
      worker.server.kill();
    }
  });

  it("validates skill-shaped packages and catches broken generated skills", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-skill-validator-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const common = path.join(root, "common");
    await mkdir(path.join(common, "good-skill", "references"), { recursive: true });
    await mkdir(path.join(common, "good-skill", "agents"), { recursive: true });
    await mkdir(path.join(common, "bad-skill"), { recursive: true });
    await mkdir(path.join(common, "scratchy-skill", "assets"), { recursive: true });
    await mkdir(path.join(common, "contest-skill", "references"), { recursive: true });
    await writeFile(
      path.join(common, "good-skill", "SKILL.md"),
      [
        "---",
        "name: good-skill",
        "description: Use when Codex needs to perform a well-scoped reusable workflow with validated references and fresh-context forward testing.",
        "---",
        "",
        "# Good Skill",
        "",
        "Use references/guide.md when the task needs detailed steps.",
        "Run validation after edits and record a fresh-context forward-test prompt and result.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(common, "good-skill", "references", "guide.md"), "Detailed guide.\n", "utf8");
    await writeFile(
      path.join(common, "good-skill", "agents", "openai.yaml"),
      [
        "interface:",
        "  display_name: Good Skill",
        "  short_description: Validates nested agent metadata.",
        "  default_prompt: Use this skill carefully.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(common, "bad-skill", "SKILL.md"),
      [
        "---",
        "name: Bad Skill",
        "description: Handy.",
        "---",
        "",
        "# Bad",
        "",
        "See [missing](references/missing.md).",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(common, "bad-skill", "README.md"), "clutter\n", "utf8");
    await writeFile(
      path.join(common, "scratchy-skill", "SKILL.md"),
      [
        "---",
        "name: scratchy-skill",
        "description: Use when Codex needs to test generated skill grounding, resource portability, and evidence hygiene.",
        "---",
        "",
        "# Scratchy Skill",
        "",
        "Follow the source notes from /tmp/skill-build/session.json before using this skill.",
        "Use progressive disclosure for scripts/ and assets/ when they are relevant.",
        "Record a fresh-context forward-test result.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(common, "scratchy-skill", "assets", "example.png"), "not really png\n", "utf8");
    await writeFile(
      path.join(common, "contest-skill", "SKILL.md"),
      [
        "---",
        "name: contest-skill",
        "description: Use when Codex needs to generate programming contest problem statements for an olympiad.",
        "---",
        "",
        "# Contest Skill",
        "",
        "Use references/style.md for house style.",
        "Write a statement and run sample verification before a fresh-context forward-test.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(common, "contest-skill", "references", "style.md"), "Style guide.\n", "utf8");
    const worker = await spawnWorker(root, data, "run-skill", "leader-1", common);
    try {
      const listed = await worker.client.call("tools/list", {});
      expect((listed.tools as { name: string }[]).map((tool) => tool.name)).toContain("validate_skill");

      const good = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "validate_skill",
          arguments: { path: "$COMMON_WORKSPACE/good-skill" },
        })).content[0].text,
      );
      expect(good.ok).toBe(true);
      expect(good.summary.errors).toBe(0);
      expect(good.metadata.name).toBe("good-skill");
      expect(good.findings).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ severity: "warning", category: "metadata" }),
        ]),
      );

      const bad = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "validate_skill",
          arguments: { path: "$COMMON_WORKSPACE/bad-skill" },
        })).content[0].text,
      );
      expect(bad.ok).toBe(false);
      expect(bad.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ severity: "error", category: "frontmatter" }),
          expect.objectContaining({ severity: "error", category: "resources" }),
          expect.objectContaining({ severity: "warning", category: "clutter" }),
          expect.objectContaining({ severity: "warning", category: "forward_test" }),
        ]),
      );

      const scratchy = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "validate_skill",
          arguments: { path: "$COMMON_WORKSPACE/scratchy-skill" },
        })).content[0].text,
      );
      expect(scratchy.ok).toBe(true);
      expect(scratchy.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ severity: "warning", category: "portability" }),
          expect.objectContaining({ severity: "warning", category: "grounding" }),
        ]),
      );

      const contest = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "validate_skill",
          arguments: { path: "$COMMON_WORKSPACE/contest-skill" },
        })).content[0].text,
      );
      expect(contest.ok).toBe(true);
      expect(contest.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "warning",
            category: "contest_gate",
            message: expect.stringContaining("brute-vs-reference cross-checking"),
          }),
          expect.objectContaining({
            severity: "warning",
            category: "contest_gate",
            message: expect.stringContaining("originality or reskin auditing"),
          }),
          expect.objectContaining({
            severity: "warning",
            category: "contest_gate",
            message: expect.stringContaining("unintended-solution probing"),
          }),
        ]),
      );
    } finally {
      worker.server.kill();
    }
  });

  it("publishes, discovers, and installs reusable skills through the skill hub", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-skill-hub-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const common = path.join(root, "common");
    await mkdir(path.join(common, "skill-src", "references"), { recursive: true });
    await writeFile(
      path.join(common, "skill-src", "SKILL.md"),
      [
        "---",
        "name: shared-skill",
        "description: Use when Codex needs to share a validated reusable workflow across future Launchpad agent runs.",
        "---",
        "",
        "# Shared Skill",
        "",
        "Use [missing](references/missing.md) for the detailed workflow.",
        "Run validation and record a fresh-context forward-test result before relying on changes.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(common, "skill-src", "references", "guide.md"), "Reusable steps.\n", "utf8");

    const publisher = await spawnWorker(root, data, "run-publisher", "leader-1", common);
    const installer = await spawnWorker(root, data, "run-installer", "leader-2", common);
    try {
      const blocked = JSON.parse(
        (await publisher.client.call("tools/call", {
          name: "publish_skill",
          arguments: { path: "$COMMON_WORKSPACE/skill-src", version: "v1" },
        })).content[0].text,
      );
      expect(blocked.ok).toBe(false);
      expect(blocked.error).toBe("SKILL_VALIDATION_FAILED");

      await writeFile(
        path.join(common, "skill-src", "SKILL.md"),
        [
          "---",
          "name: shared-skill",
          "description: Use when Codex needs to share a validated reusable workflow across future Launchpad agent runs.",
          "---",
          "",
          "# Shared Skill",
          "",
          "Use progressive disclosure with references/guide.md for the detailed workflow.",
          "Run validation and record a fresh-context forward-test result before relying on changes.",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        path.join(common, "skill-src", "PURPOSE.md"),
        [
          "# Purpose",
          "",
          "Origin: wiki/patterns/reusable-workflow.md",
          "Patterns addressed: repeated workflow rebuilds without checking the persistent hub.",
        ].join("\n"),
        "utf8",
      );

      const wikiUpdate = JSON.parse(
        (await publisher.client.call("tools/call", {
          name: "update_skill_wiki",
          arguments: {
            create_patterns: [
              {
                name: "reusable-workflow.md",
                content:
                  "# Reusable workflow rebuilds\n\nAgents sometimes rebuild reusable workflows even when a persistent hub skill already exists.\n\n## Fix\n\nSearch the hub first, then install the matching skill.",
              },
            ],
            update_index:
              "# Skill Wiki Index\n\n- [reusable-workflow](patterns/reusable-workflow.md): Agents rebuild workflows because they skip the persistent hub; search and install the matching skill before creating a replacement.\n",
            append_log: "Created reusable-workflow after a successful forward-test showed the hub path should be reused.",
            evidence_refs: ["run-publisher:trace:1"],
          },
        })).content[0].text,
      );
      expect(wikiUpdate.ok).toBe(true);
      expect(wikiUpdate.created).toContain("patterns/reusable-workflow.md");

      const patternPage = JSON.parse(
        (await installer.client.call("tools/call", {
          name: "read_skill_wiki",
          arguments: { path: "patterns/reusable-workflow.md" },
        })).content[0].text,
      );
      expect(patternPage.ok).toBe(true);
      expect(patternPage.text).toContain("Search the hub first");
      expect(patternPage.text).toContain("run-publisher:trace:1");

      const patchedPattern = JSON.parse(
        (await publisher.client.call("tools/call", {
          name: "update_skill_wiki",
          arguments: {
            update_patterns: [
              {
                name: "patterns/reusable-workflow.md",
                edits: [
                  {
                    op: "insert_after",
                    target: "Search the hub first",
                    content: " and read skill impact history",
                  },
                ],
              },
            ],
            append_log: "Refined the reusable-workflow fix with impact-history guidance.",
          },
        })).content[0].text,
      );
      expect(patchedPattern.ok).toBe(true);
      expect(patchedPattern.changed).toContain("patterns/reusable-workflow.md");

      const published = JSON.parse(
        (await publisher.client.call("tools/call", {
          name: "publish_skill",
          arguments: {
            path: "$COMMON_WORKSPACE/skill-src",
            version: "v1",
            tags: ["workflow", "Reusable"],
            notes: "forward-tested by run-publisher",
            origin_patterns: ["patterns/reusable-workflow.md"],
            evidence_refs: ["run-publisher:forward-test"],
          },
        })).content[0].text,
      );
      expect(published.ok).toBe(true);
      expect(published.skill).toMatchObject({
        name: "shared-skill",
        version: "v1",
        tags: ["workflow", "reusable"],
        originPatterns: ["patterns/reusable-workflow.md"],
        evidenceRefs: ["run-publisher:forward-test"],
        ownerRunId: "run-publisher",
      });

      const discovered = JSON.parse(
        (await installer.client.call("tools/call", {
          name: "search_skills",
          arguments: { query: "workflow" },
        })).content[0].text,
      );
      expect(discovered.ok).toBe(true);
      expect(discovered.skills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "shared-skill", version: "v1" }),
        ]),
      );

      const toolSearch = JSON.parse(
        (await installer.client.call("tools/call", {
          name: "tool_search",
          arguments: { query: "workflow", limit: 20 },
        })).content[0].text,
      );
      expect(toolSearch.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "skill:shared-skill",
            callWith: "read_skill",
            installWith: "install_skill",
          }),
        ]),
      );

      const detail = JSON.parse(
        (await installer.client.call("tools/call", {
          name: "read_skill",
          arguments: { name: "shared-skill", max_chars: 2000 },
        })).content[0].text,
      );
      expect(detail.ok).toBe(true);
      expect(detail.skillMd).toContain("name: shared-skill");
      expect(detail.purposeMd).toContain("wiki/patterns/reusable-workflow.md");
      expect(detail.install.codexHomeArguments).toEqual({
        name: "shared-skill",
        version: "v1",
        scope: "codex_home",
      });

      await writeFile(
        path.join(common, "skill-src", "SKILL.md"),
        [
          "---",
          "name: shared-skill",
          "description: Use when Codex needs to share and improve a validated reusable workflow across future Launchpad agent runs.",
          "---",
          "",
          "# Shared Skill",
          "",
          "Use progressive disclosure with references/guide.md for the detailed workflow.",
          "Search the skill wiki impact history before patching this workflow.",
          "Run validation and record a fresh-context forward-test result before relying on changes.",
        ].join("\n"),
        "utf8",
      );

      const staged = JSON.parse(
        (await publisher.client.call("tools/call", {
          name: "stage_skill_proposal",
          arguments: {
            candidate_path: "$COMMON_WORKSPACE/skill-src",
            base_version: "v1",
            proposed_version: "v2",
            proposal_summary: "Require skill wiki impact-history checks before patching",
            diff: "+Search the skill wiki impact history before patching this workflow.",
            origin_patterns: ["patterns/reusable-workflow.md"],
            evidence_refs: ["run-publisher:trace:2"],
            notes: "candidate passed structural validation",
          },
        })).content[0].text,
      );
      expect(staged.ok).toBe(true);
      expect(staged.proposal.skill).toBe("shared-skill");
      expect(staged.proposal.status).toBe("staged");

      const listedStaged = JSON.parse(
        (await installer.client.call("tools/call", {
          name: "list_skill_proposals",
          arguments: { skill: "shared-skill", status: "staged", query: "impact-history" },
        })).content[0].text,
      );
      expect(listedStaged.ok).toBe(true);
      expect(listedStaged.proposals.map((proposal: { id: string }) => proposal.id)).toContain(
        staged.proposal.id,
      );

      const stagedDetail = JSON.parse(
        (await installer.client.call("tools/call", {
          name: "read_skill_proposal",
          arguments: { proposal_id: staged.proposal.id },
        })).content[0].text,
      );
      expect(stagedDetail.ok).toBe(true);
      expect(stagedDetail.skillMd).toContain("impact history before patching");

      const finalized = JSON.parse(
        (await publisher.client.call("tools/call", {
          name: "finalize_skill_proposal",
          arguments: {
            proposal_id: staged.proposal.id,
            accepted: true,
            validation_score: "1.0",
            validation_delta: "+0.10",
            publish: true,
            notes: "accepted by v2 validation gate",
          },
        })).content[0].text,
      );
      expect(finalized.ok).toBe(true);
      expect(finalized.proposal.status).toBe("accepted");
      expect(finalized.published.skill).toMatchObject({
        name: "shared-skill",
        version: "v2",
        originPatterns: ["patterns/reusable-workflow.md"],
        supersedesVersion: "v1",
      });

      const listedAccepted = JSON.parse(
        (await installer.client.call("tools/call", {
          name: "list_skill_proposals",
          arguments: { status: "accepted", query: "impact-history" },
        })).content[0].text,
      );
      expect(listedAccepted.proposals.map((proposal: { id: string }) => proposal.id)).toContain(
        staged.proposal.id,
      );

      const duplicateFinalize = JSON.parse(
        (await publisher.client.call("tools/call", {
          name: "finalize_skill_proposal",
          arguments: {
            proposal_id: staged.proposal.id,
            accepted: false,
          },
        })).content[0].text,
      );
      expect(duplicateFinalize.ok).toBe(false);
      expect(duplicateFinalize.error).toBe("SKILL_PROPOSAL_ALREADY_FINALIZED");

      const latestAfterProposal = JSON.parse(
        (await installer.client.call("tools/call", {
          name: "read_skill",
          arguments: { name: "shared-skill" },
        })).content[0].text,
      );
      expect(latestAfterProposal.ok).toBe(true);
      expect(latestAfterProposal.skill.version).toBe("v2");
      expect(latestAfterProposal.skill.supersedesVersion).toBe("v1");

      await mkdir(path.join(common, "no-purpose-skill"), { recursive: true });
      await writeFile(
        path.join(common, "no-purpose-skill", "SKILL.md"),
        [
          "---",
          "name: no-purpose-skill",
          "description: Use when Codex needs a wiki-originated skill publication that demonstrates provenance warnings.",
          "---",
          "",
          "# No Purpose Skill",
          "",
          "Use progressive disclosure with references/ when resources are added.",
          "Run validation and record a fresh-context forward-test result before relying on changes.",
        ].join("\n"),
        "utf8",
      );
      const provenanceWarning = JSON.parse(
        (await publisher.client.call("tools/call", {
          name: "publish_skill",
          arguments: {
            path: "$COMMON_WORKSPACE/no-purpose-skill",
            version: "v1",
            origin_patterns: ["patterns/reusable-workflow.md"],
          },
        })).content[0].text,
      );
      expect(provenanceWarning.ok).toBe(true);
      expect(provenanceWarning.skill.provenanceWarnings).toContain(
        "Skill publication cites origin_patterns but the skill folder has no PURPOSE.md explaining provenance.",
      );

      const impact = JSON.parse(
        (await publisher.client.call("tools/call", {
          name: "record_skill_impact",
          arguments: {
            skill: "shared-skill",
            version: "v1",
            accepted: true,
            validation_score: "1.0",
            validation_delta: "+0.25",
            proposal_summary: "Add reusable workflow guidance",
            diff: "+Run validation and record a fresh-context forward-test result",
            origin_patterns: ["patterns/reusable-workflow.md"],
            evidence_refs: ["run-publisher:forward-test"],
            notes: "accepted after validation",
          },
        })).content[0].text,
      );
      expect(impact.ok).toBe(true);
      expect(impact.impact.accepted).toBe(true);

      const wikiSearch = JSON.parse(
        (await installer.client.call("tools/call", {
          name: "search_skill_wiki",
          arguments: { query: "reusable workflow", skill: "shared-skill" },
        })).content[0].text,
      );
      expect(wikiSearch.ok).toBe(true);
      expect(wikiSearch.results.map((result: { path: string }) => result.path)).toContain(
        "skill-impact.md",
      );

      const patternSearch = JSON.parse(
        (await installer.client.call("tools/call", {
          name: "search_skill_wiki",
          arguments: { query: "impact history", limit: 10 },
        })).content[0].text,
      );
      expect(patternSearch.results.map((result: { path: string }) => result.path)).toContain(
        "patterns/reusable-workflow.md",
      );

      const wikiImpact = JSON.parse(
        (await installer.client.call("tools/call", {
          name: "read_skill_wiki",
          arguments: { path: "skill-impact.md" },
        })).content[0].text,
      );
      expect(wikiImpact.ok).toBe(true);
      expect(wikiImpact.text).toContain("Accepted - shared-skill@v1");

      const wikiResource = await installer.client.call("resources/read", {
        uri: "launchpad://skill-wiki/skill-impact.md",
      });
      expect(wikiResource.contents[0].text).toContain("shared-skill@v1");

      const bootstrapped = JSON.parse(
        (await installer.client.call("tools/call", {
          name: "bootstrap_context",
          arguments: {},
        })).content[0].text,
      );
      expect(bootstrapped.skillWiki.impact).toBe("launchpad://skill-wiki/skill-impact.md");

      const resourceDetail = await installer.client.call("resources/read", {
        uri: "launchpad://skill/shared-skill",
      });
      expect(resourceDetail.contents[0].text).toContain("name: shared-skill");

      const installed = JSON.parse(
        (await installer.client.call("tools/call", {
          name: "install_skill",
          arguments: { name: "shared-skill" },
        })).content[0].text,
      );
      expect(installed.ok).toBe(true);
      expect(installed.installed.installedPath).toBe("$COMMON_WORKSPACE/skills/shared-skill");
      await expect(
        readFile(path.join(common, "skills", "shared-skill", "references", "guide.md"), "utf8"),
      ).resolves.toBe("Reusable steps.\n");

      const codexHomeInstalled = JSON.parse(
        (await installer.client.call("tools/call", {
          name: "install_skill",
          arguments: { name: "shared-skill", scope: "codex_home" },
        })).content[0].text,
      );
      expect(codexHomeInstalled.ok).toBe(true);
      expect(codexHomeInstalled.installed.installedPath).toBe(
        "$CODEX_HOME/skills/shared-skill",
      );
      await expect(
        readFile(
          path.join(installer.codexHome, "skills", "shared-skill", "SKILL.md"),
          "utf8",
        ),
      ).resolves.toContain("name: shared-skill");
    } finally {
      publisher.server.kill();
      installer.server.kill();
    }
  });

  it("runs long shell work as inspectable background jobs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-job-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const worker = await spawnWorker(root, data, "run-job", "leader-1");
    try {
      const started = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "start_job",
          arguments: {
            command:
              process.execPath +
              " -e \"setTimeout(() => { console.log('job done') }, 50)\"",
            timeout_seconds: 5,
          },
        })).content[0].text,
      );
      expect(started.ok).toBe(true);
      expect(started.job.status).toBe("running");

      const listed = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "list_jobs",
          arguments: {},
        })).content[0].text,
      );
      expect(listed.jobs.map((job: { id: string }) => job.id)).toContain(started.job.id);

      const waited = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "wait_job",
          arguments: { job_id: started.job.id, timeout_seconds: 10 },
        })).content[0].text,
      );
      expect(waited.ok).toBe(true);
      expect(waited.job.status).toBe("completed");
      expect(waited.stdout).toContain("job done");

      const reread = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "read_job_output",
          arguments: {
            job_id: started.job.id,
            stdout_offset: waited.nextStdoutOffset,
            stderr_offset: waited.nextStderrOffset,
          },
        })).content[0].text,
      );
      expect(reread.stdout).toBe("");
      expect(reread.stderr).toBe("");
    } finally {
      worker.server.kill();
    }
  }, 20_000);

  it("runs background jobs with cache-backed python first on the shell path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-job-python-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const cache = path.join(root, "cache");
    const pythonBin = path.join(cache, "python", "bin");
    await mkdir(pythonBin, { recursive: true });
    await mkdir(path.join(cache, "python", "user", "bin"), { recursive: true });
    const fakePython = path.join(pythonBin, "python3");
    await writeFile(
      fakePython,
      "#!/bin/sh\nprintf 'cache-python:%s\\n' \"$0\"\nprintf 'pythonuser:%s\\n' \"$PYTHONUSERBASE\"\n",
    );
    await chmod(fakePython, 0o755);
    await writeFile(
      path.join(cache, "python", "shell-env.sh"),
      "python3() { \"$LAUNCHPAD_DEPENDENCY_CACHE/python/bin/python3\" \"$@\"; }\n",
    );
    const worker = await spawnWorker(root, data, "run-job-python", "leader-1", undefined, {
      LAUNCHPAD_DEPENDENCY_CACHE: cache,
      PATH: "/usr/bin:/bin",
    });
    try {
      const started = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "start_job",
          arguments: {
            command: "python3 -m pip --version",
            timeout_seconds: 5,
          },
        })).content[0].text,
      );
      const waited = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "wait_job",
          arguments: { job_id: started.job.id, timeout_seconds: 1 },
        })).content[0].text,
      );

      expect(waited.ok).toBe(true);
      expect(waited.stdout).toContain("cache-python:" + fakePython);
      expect(waited.stdout).toContain("pythonuser:" + path.join(cache, "python", "user"));
    } finally {
      worker.server.kill();
    }
  });

  it("cancels running background jobs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-job-cancel-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const worker = await spawnWorker(root, data, "run-cancel", "leader-1");
    try {
      const started = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "start_job",
          arguments: {
            command: process.execPath + " -e \"setInterval(() => {}, 1000)\"",
            timeout_seconds: 30,
          },
        })).content[0].text,
      );
      expect(started.ok).toBe(true);

      const cancelled = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "cancel_job",
          arguments: { job_id: started.job.id },
        })).content[0].text,
      );
      expect(cancelled.ok).toBe(true);
      expect(cancelled.job.status).toBe("cancelled");
    } finally {
      worker.server.kill();
    }
  });

  it("kills mutation: kill only a background-job shell while its descendant survives", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-job-group-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const worker = await spawnWorker(root, data, "run-group", "leader-1");
    const marker = path.join(worker.workspace, "pids.json");
    const late = path.join(worker.workspace, "late-mutation.txt");
    await writeFile(
      path.join(worker.workspace, "fork.mjs"),
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const child = spawn(process.execPath, ['-e', " +
          JSON.stringify(
            "setTimeout(() => require('fs').writeFileSync(" +
              JSON.stringify(late) +
              ", 'mutated'), 4000); setInterval(() => {}, 1000);",
          ) +
          "], { stdio: 'ignore' });",
        "writeFileSync(" + JSON.stringify(marker) + ", JSON.stringify({ parent: process.pid, child: child.pid }));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    try {
      const started = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "start_job",
          arguments: {
            command: process.execPath + " fork.mjs",
            timeout_seconds: 30,
          },
        })).content[0].text,
      );
      expect(started.ok).toBe(true);
      await expect.poll(() => {
        try {
          return JSON.parse(require("node:fs").readFileSync(marker, "utf8")).child;
        } catch {
          return 0;
        }
      }, { timeout: 10_000 }).toBeGreaterThan(0);
      const pids = JSON.parse(await (await import("node:fs/promises")).readFile(marker, "utf8")) as {
        parent: number;
        child: number;
      };
      const cancelled = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "cancel_job",
          arguments: { job_id: started.job.id },
        })).content[0].text,
      );
      expect(cancelled.ok).toBe(true);
      await expect.poll(() => pidAlive(pids.parent)).toBe(false);
      await expect.poll(() => pidAlive(pids.child)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await expect(
        (await import("node:fs/promises")).access(late),
      ).rejects.toThrow();
    } finally {
      worker.server.kill();
    }
  }, 15_000);

  it("kills mutation: hide a forbidden operation inside batch_tool_call", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-batch-auth-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const worker = await spawnWorker(root, data, "run-worker", "leader-1");
    try {
      const batch = await worker.client.call("tools/call", {
        name: "batch_tool_call",
        arguments: {
          calls: [
            { tool_name: "list_files", arguments: { max_entries: 1 } },
            { tool_name: "dispatch_subagent", arguments: { prompt: "do forbidden work" } },
            { tool_name: "extend_worker_timeout", arguments: { target: "x", additional_seconds: 30 } },
          ],
        },
      });
      const body = JSON.parse(batch.content[0].text);
      expect(body.ok).toBe(false);
      expect(body.results[0]).toMatchObject({ tool: "list_files", ok: true });
      expect(body.results[1].ok).toBe(false);
      expect(String(body.results[1].error)).toMatch(/leader|UNAUTHORI/i);
      expect(String(body.results[1].error)).not.toMatch(/ingress was provisioned/i);
      expect(body.results[2].ok).toBe(false);
      expect(String(body.results[2].error)).toMatch(/leader|UNAUTHORI/i);
    } finally {
      worker.server.kill();
    }
  });

  it("refuses dispatch, timeout extension, start_job, and nested batch members after the root is terminal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-mcp-terminal-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const worker = await spawnWorker(root, data, "leader-1", "leader-1", undefined, {
      LAUNCHPAD_ROOT_DEADLINE_AT: new Date(Date.now() - 1_000).toISOString(),
    });
    try {
      const dispatch = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "dispatch_subagent",
          arguments: { prompt: "too late" },
        })).content[0].text,
      );
      expect(dispatch.ok).toBe(false);
      expect(String(dispatch.error)).toMatch(/RUN_TERMINAL/);

      const extend = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "extend_worker_timeout",
          arguments: { target: "x", additional_seconds: 30 },
        })).content[0].text,
      );
      expect(extend.ok).toBe(false);
      expect(String(extend.error)).toMatch(/RUN_TERMINAL/);

      const job = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "start_job",
          arguments: { command: "echo late" },
        })).content[0].text,
      );
      expect(job.ok).toBe(false);
      expect(String(job.error)).toMatch(/RUN_TERMINAL/);

      const inspect = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "inspect_worker_progress",
          arguments: { target: "x" },
        })).content[0].text,
      );
      expect(String(inspect.error ?? "")).not.toMatch(/RUN_TERMINAL/);

      const batch = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "batch_tool_call",
          arguments: {
            calls: [
              { tool_name: "list_files", arguments: { max_entries: 1 } },
              { tool_name: "start_job", arguments: { command: "echo nested" } },
              { tool_name: "dispatch_subagent", arguments: { prompt: "nested" } },
            ],
          },
        })).content[0].text,
      );
      expect(batch.ok).toBe(false);
      expect(batch.results[0]).toMatchObject({ tool: "list_files", ok: true });
      expect(String(batch.results[1].error)).toMatch(/RUN_TERMINAL/);
      expect(String(batch.results[2].error)).toMatch(/RUN_TERMINAL/);
    } finally {
      worker.server.kill();
    }
  });

  it("bounds wait_job to the remaining root deadline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-wait-deadline-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const deadline = new Date(Date.now() + 2_000).toISOString();
    const worker = await spawnWorker(root, data, "run-wait", "leader-1", undefined, {
      LAUNCHPAD_ROOT_DEADLINE_AT: deadline,
    });
    try {
      const started = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "start_job",
          arguments: {
            command: process.execPath + " -e \"setTimeout(()=>{}, 20000)\"",
            timeout_seconds: 30,
          },
        })).content[0].text,
      );
      const began = Date.now();
      const waited = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "wait_job",
          arguments: { job_id: started.job.id, timeout_seconds: 60 },
        })).content[0].text,
      );
      expect(Date.now() - began).toBeLessThan(4_000);
      expect(waited.job.status).toBe("running");
    } finally {
      worker.server.kill("SIGTERM");
    }
  }, 10_000);

  it("passes artifacts between sibling workers via the shared run dir", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-collab-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const a = await spawnWorker(root, data, "run-a", "leader-1");
    const b = await spawnWorker(root, data, "run-b", "leader-1");
    try {
      const published = await a.client.call("tools/call", {
        name: "publish_artifact",
        arguments: { text: "shared finding X", type: "note", description: "from A" },
      });
      const artifact = JSON.parse(published.content[0].text).artifact;

      const listed = JSON.parse(
        (await b.client.call("tools/call", { name: "list_artifacts", arguments: {} }))
          .content[0].text,
      );
      expect(listed.artifacts.map((x: { id: string }) => x.id)).toContain(artifact.id);

      const read = JSON.parse(
        (await b.client.call("tools/call", {
          name: "read_artifact",
          arguments: { artifact_id: artifact.id },
        })).content[0].text,
      );
      expect(read.text).toBe("shared finding X");
    } finally {
      a.server.kill();
      b.server.kill();
    }
  });

  it("shares custom tools between sibling workers in the same leader run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-custom-tool-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const common = path.join(root, "common");
    await mkdir(common, { recursive: true });
    await writeFile(
      path.join(common, "double.cjs"),
      [
        "const args = JSON.parse(process.env.LAUNCHPAD_CUSTOM_TOOL_ARGS || '{}');",
        "process.stdout.write(String(Number(args.x) * 2));",
      ].join("\n"),
    );
    const a = await spawnWorker(root, data, "run-a", "leader-1", common);
    const b = await spawnWorker(root, data, "run-b", "leader-1", common);
    try {
      const registered = JSON.parse(
        (await a.client.call("tools/call", {
          name: "register_custom_tool",
          arguments: {
            name: "double",
            description: "Doubles numeric argument x",
            path: "$COMMON_WORKSPACE/double.cjs",
          },
        })).content[0].text,
      );
      expect(registered.ok).toBe(true);
      expect(registered.tool.path).toBe("$COMMON_WORKSPACE/double.cjs");

      const listed = JSON.parse(
        (await b.client.call("tools/call", {
          name: "list_custom_tools",
          arguments: {},
        })).content[0].text,
      );
      expect(listed.tools.map((tool: { name: string }) => tool.name)).toContain("double");

      const bootstrapped = JSON.parse(
        (await b.client.call("tools/call", {
          name: "bootstrap_context",
          arguments: {},
        })).content[0].text,
      );
      expect(bootstrapped.customTools.map((tool: { name: string }) => tool.name)).toContain(
        "double",
      );
      expect(bootstrapped.sharedFiles.map((file: { path: string }) => file.path)).toContain(
        "$COMMON_WORKSPACE/double.cjs",
      );

      const discovered = JSON.parse(
        (await b.client.call("tools/call", {
          name: "tool_search",
          arguments: { query: "double", limit: 5 },
        })).content[0].text,
      );
      expect(discovered.results.map((tool: { name: string }) => tool.name)).toContain("custom:double");

      const called = JSON.parse(
        (await b.client.call("tools/call", {
          name: "call_custom_tool",
          arguments: { name: "double", arguments: { x: 21 } },
        })).content[0].text,
      );
      expect(called.ok).toBe(true);
      expect(called.stdout).toBe("42");
    } finally {
      a.server.kill();
      b.server.kill();
    }
  });

  it("rejects duplicate custom tool names across sibling workers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-custom-tool-dupe-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const common = path.join(root, "common");
    await mkdir(common, { recursive: true });
    await writeFile(path.join(common, "one.cjs"), "process.stdout.write('one');");
    await writeFile(path.join(common, "two.cjs"), "process.stdout.write('two');");
    const a = await spawnWorker(root, data, "run-a", "leader-1", common);
    const b = await spawnWorker(root, data, "run-b", "leader-1", common);
    try {
      const first = JSON.parse(
        (await a.client.call("tools/call", {
          name: "register_custom_tool",
          arguments: { name: "Formatter", path: "$COMMON_WORKSPACE/one.cjs" },
        })).content[0].text,
      );
      expect(first.ok).toBe(true);

      const duplicate = JSON.parse(
        (await b.client.call("tools/call", {
          name: "register_custom_tool",
          arguments: { name: "formatter", path: "$COMMON_WORKSPACE/two.cjs" },
        })).content[0].text,
      );
      expect(duplicate.ok).toBe(false);
      expect(duplicate.error).toContain("CUSTOM_TOOL_NAME_EXISTS");
    } finally {
      a.server.kill();
      b.server.kill();
    }
  });

  it("includes middleware-selected skills in bootstrap context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-selected-skills-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    await mkdir(data, { recursive: true });
    await writeFile(
      path.join(data, "launchpad.json"),
      JSON.stringify({
        agents: [],
        messages: [],
        runs: [
          {
            id: "leader-1",
            orchestration: {
              skillRouting: [
                {
                  task: "Extract citations from an academic PDF.",
                  createdAt: "2026-08-30T00:00:00.000Z",
                  install: [
                    {
                      name: "academic-pdf-extractor",
                      version: "1.4",
                      scope: "run",
                      installedPath: "$COMMON_WORKSPACE/skills/academic-pdf-extractor",
                    },
                  ],
                  selected: [
                    {
                      score: 0.91,
                      reasons: ["exact capability tag"],
                      risks: [],
                      candidate: {
                        name: "academic-pdf-extractor",
                        version: "1.4",
                        installArguments: {
                          destination: "$COMMON_WORKSPACE/skills/academic-pdf-extractor",
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
        ],
      }),
      "utf8",
    );
    const worker = await spawnWorker(root, data, "worker-1", "leader-1");

    try {
      const bootstrapped = JSON.parse(
        (await worker.client.call("tools/call", {
          name: "bootstrap_context",
          arguments: {},
        })).content[0].text,
      );
      expect(bootstrapped.selectedSkills).toEqual([
        expect.objectContaining({
          name: "academic-pdf-extractor",
          version: "1.4",
          installedPath: "$COMMON_WORKSPACE/skills/academic-pdf-extractor",
          reasons: ["exact capability tag"],
        }),
      ]);

      const context = await worker.client.call("resources/read", {
        uri: "launchpad://context",
      });
      expect(context.contents[0].text).toContain("selectedSkills");
      expect(context.contents[0].text).toContain("academic-pdf-extractor");
    } finally {
      worker.server.kill("SIGTERM");
    }
  });

  it("returns a readable read_file hint when the path is a published artifact source", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-artifact-source-hint-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const a = await spawnWorker(root, data, "run-a", "leader-1");
    const b = await spawnWorker(root, data, "run-b", "leader-1");
    try {
      await writeFile(path.join(a.workspace, "quantum_crypto_abstract.md"), "abstract body");
      const published = await a.client.call("tools/call", {
        name: "publish_artifact",
        arguments: {
          path: "quantum_crypto_abstract.md",
          description: "Formal academic abstract",
        },
      });
      const artifact = JSON.parse(published.content[0].text).artifact;

      const readByPath = await b.client.call("tools/call", {
        name: "read_file",
        arguments: { path: "quantum_crypto_abstract.md" },
      });
      const body = JSON.parse(readByPath.content[0].text);
      expect(readByPath.isError).toBe(true);
      expect(body.ok).toBe(false);
      expect(body.artifact_id).toBe(artifact.id);
      expect(body.hint).toContain("read_artifact");

      const readArtifact = JSON.parse(
        (await b.client.call("tools/call", {
          name: "read_artifact",
          arguments: { artifact_id: artifact.id },
        })).content[0].text,
      );
      expect(readArtifact.text).toBe("abstract body");
    } finally {
      a.server.kill();
      b.server.kill();
    }
  });

  it("returns structured tool output instead of JSON-RPC errors for file failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-file-failure-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const worker = await spawnWorker(root, data, "run-a", "leader-1");
    try {
      const result = await worker.client.call("tools/call", {
        name: "read_file",
        arguments: { path: "missing.md" },
      });
      const body = JSON.parse(result.content[0].text);
      expect(result.isError).toBe(true);
      expect(body.ok).toBe(false);
      expect(body.error).toBe("Workspace file could not be read.");
      expect(body.hint).toContain("private /workspace");
    } finally {
      worker.server.kill();
    }
  });

  it("returns a readable read_artifact error for missing artifact ids", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-missing-artifact-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const worker = await spawnWorker(root, data, "run-a", "leader-1");
    try {
      const result = await worker.client.call("tools/call", {
        name: "read_artifact",
        arguments: { artifact_id: "missing-artifact" },
      });
      const body = JSON.parse(result.content[0].text);
      expect(result.isError).toBe(true);
      expect(body.ok).toBe(false);
      expect(body.error).toBe("Artifact was not found.");
      expect(body.hint).toContain("list_artifacts");
    } finally {
      worker.server.kill();
    }
  });

  it("publishes files from COMMON_WORKSPACE when they are not in the private workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-common-artifact-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const common = path.join(root, "common");
    const data = path.join(root, "data");
    const serverPath = path.join(root, "launchpad-mcp-server.mjs");
    await mkdir(workspace, { recursive: true });
    await mkdir(common, { recursive: true });
    await writeFile(serverPath, LAUNCHPAD_MCP_SERVER_SOURCE, "utf8");
    await writeFile(path.join(common, "player2_moves.json"), "[\"rock\"]");

    const server = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        COMMON_WORKSPACE: common,
        LAUNCHPAD_WORKSPACE_PATH: workspace,
        LAUNCHPAD_DATA_DIR: data,
        LAUNCHPAD_AGENT_ID: "agent-1",
        LAUNCHPAD_RUN_ID: "run-1",
        LAUNCHPAD_PARENT_RUN_ID: "leader-1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = jsonRpcClient(server);
    try {
      await client.call("initialize", { protocolVersion: "2024-11-05" });
      const published = await client.call("tools/call", {
        name: "publish_artifact",
        arguments: {
          path: path.join(common, "player2_moves.json"),
          description: "player2 moves for 5 rounds RPS",
        },
      });
      const body = JSON.parse(published.content[0].text);
      expect(body.ok).toBe(true);
      expect(body.artifact.sourcePath).toBe("$COMMON_WORKSPACE/player2_moves.json");

      const read = await client.call("tools/call", {
        name: "read_artifact",
        arguments: { artifact_id: body.artifact.id },
      });
      expect(JSON.parse(read.content[0].text).text).toBe("[\"rock\"]");

      const readShared = await client.call("tools/call", {
        name: "read_file",
        arguments: { path: "player2_moves.json" },
      });
      const readSharedBody = JSON.parse(readShared.content[0].text);
      expect(readSharedBody.ok).toBe(true);
      expect(readSharedBody.path).toBe("$COMMON_WORKSPACE/player2_moves.json");
      expect(readSharedBody.text).toBe("[\"rock\"]");

      const readManyShared = await client.call("tools/call", {
        name: "read_many_files",
        arguments: { paths: ["$COMMON_WORKSPACE/player2_moves.json", "common-workspace/player2_moves.json"] },
      });
      const manyBody = JSON.parse(readManyShared.content[0].text);
      expect(manyBody.files.map((file: { ok: boolean }) => file.ok)).toEqual([true, true]);

      const publishedByAlias = await client.call("tools/call", {
        name: "publish_artifact",
        arguments: {
          path: "common-workspace/player2_moves.json",
          description: "player2 moves by alias",
        },
      });
      expect(JSON.parse(publishedByAlias.content[0].text).artifact.sourcePath).toBe(
        "$COMMON_WORKSPACE/player2_moves.json",
      );
    } finally {
      server.kill("SIGTERM");
    }
  });

  it("explains when an absolute shared artifact path is unavailable to MCP", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-common-artifact-missing-env-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const data = path.join(root, "data");
    const serverPath = path.join(root, "launchpad-mcp-server.mjs");
    await mkdir(workspace, { recursive: true });
    await writeFile(serverPath, LAUNCHPAD_MCP_SERVER_SOURCE, "utf8");

    const server = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        LAUNCHPAD_WORKSPACE_PATH: workspace,
        LAUNCHPAD_DATA_DIR: data,
        LAUNCHPAD_AGENT_ID: "agent-1",
        LAUNCHPAD_RUN_ID: "run-1",
        LAUNCHPAD_PARENT_RUN_ID: "leader-1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = jsonRpcClient(server);
    try {
      await client.call("initialize", { protocolVersion: "2024-11-05" });
      const published = await client.call("tools/call", {
        name: "publish_artifact",
        arguments: {
          path: "/common-workspace/ethical_vision.md",
          description: "vision",
        },
      });
      const body = JSON.parse(published.content[0].text);
      expect(body.ok).toBe(false);
      expect(body.error).toContain("COMMON_WORKSPACE is not configured");
      expect(body.hint).toContain("COMMON_WORKSPACE is not configured");
    } finally {
      server.kill("SIGTERM");
    }
  });

  it("shares whiteboard notes across siblings with since filtering", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-wb-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const a = await spawnWorker(root, data, "run-a", "leader-1");
    const b = await spawnWorker(root, data, "run-b", "leader-1");
    try {
      const posted = JSON.parse(
        (await a.client.call("tools/call", {
          name: "whiteboard_post",
          arguments: { text: "note one", kind: "finding" },
        })).content[0].text,
      );
      expect(posted.entry.authorRunId).toBe("run-a");

      const readAll = JSON.parse(
        (await b.client.call("tools/call", { name: "whiteboard_read", arguments: {} }))
          .content[0].text,
      );
      expect(readAll.entries.map((e: { text: string }) => e.text)).toContain("note one");

      const readSince = JSON.parse(
        (await b.client.call("tools/call", {
          name: "whiteboard_read",
          arguments: { since: posted.entry.createdAt },
        })).content[0].text,
      );
      expect(readSince.entries).toHaveLength(0);
    } finally {
      a.server.kill();
      b.server.kill();
    }
  });

  it("reads current directory-layout event logs via read_worker_log", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-events-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const { mkdir } = await import("node:fs/promises");
    const runDir = path.join(data, "event", "2026-08-27T00-00-00-000Z_run-x");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "events.jsonl"),
      JSON.stringify({ seq: 1, runId: "run-x", kind: "message", name: "hello", output: { text: "hi" } }) + "\n",
      "utf8",
    );
    const a = await spawnWorker(root, data, "run-x", "leader-9");
    try {
      const out = JSON.parse(
        (await a.client.call("tools/call", {
          name: "read_worker_log",
          arguments: { run_id: "run-x" },
        })).content[0].text,
      );
      expect(out.events.map((e: { name: string }) => e.name)).toContain("hello");
    } finally {
      a.server.kill();
    }
  });

  it("resolves a run via the session manifest to its member folder", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-events-session-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const { mkdir } = await import("node:fs/promises");
    // New layout: one session dir, a manifest mapping members to run ids, each
    // member holding trajectory.jsonl.
    const sessionDir = path.join(data, "event", "2026-08-27T17-00-00-000Z_leader-9");
    await mkdir(path.join(sessionDir, "workeragent2"), { recursive: true });
    await writeFile(
      path.join(sessionDir, "session.json"),
      JSON.stringify({
        session: "leader-9",
        members: [
          { member: "leader", runId: "leader-9", agentId: "L" },
          { member: "workeragent2", runId: "worker-run-2", agentId: "W2" },
        ],
      }),
      "utf8",
    );
    await writeFile(
      path.join(sessionDir, "workeragent2", "trajectory.jsonl"),
      JSON.stringify({ seq: 1, runId: "worker-run-2", kind: "message", name: "from-w2" }) + "\n",
      "utf8",
    );
    const a = await spawnWorker(root, data, "worker-run-2", "leader-9");
    try {
      const out = JSON.parse(
        (await a.client.call("tools/call", {
          name: "read_worker_log",
          arguments: { run_id: "worker-run-2" },
        })).content[0].text,
      );
      expect(out.events.map((e: { name: string }) => e.name)).toContain("from-w2");
    } finally {
      a.server.kill();
    }
  });

  it("still reads legacy flat event logs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-events-legacy-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const { mkdir } = await import("node:fs/promises");
    const eventsDir = path.join(data, "events");
    await mkdir(eventsDir, { recursive: true });
    await writeFile(
      path.join(eventsDir, "2026-01-01T00-00-00-000Z-run-y.jsonl"),
      JSON.stringify({ seq: 1, runId: "run-y", kind: "message", name: "legacy" }) + "\n",
      "utf8",
    );
    const a = await spawnWorker(root, data, "run-y", "leader-9");
    try {
      const out = JSON.parse(
        (await a.client.call("tools/call", {
          name: "read_worker_log",
          arguments: { run_id: "run-y" },
        })).content[0].text,
      );
      expect(out.events.map((e: { name: string }) => e.name)).toContain("legacy");
    } finally {
      a.server.kill();
    }
  });
  it("exposes resource templates and reads a shared item by id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-res-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const a = await spawnWorker(root, data, "run-a", "leader-1");
    try {
      const templates = await a.client.call("resources/templates/list", {});
      expect(
        templates.resourceTemplates.map(
          (t: { uriTemplate: string }) => t.uriTemplate,
        ),
      ).toEqual(
        expect.arrayContaining([
          "launchpad://artifact/{id}",
          "launchpad://skill/{name}",
          "launchpad://whiteboard/{id}",
        ]),
      );

      const published = JSON.parse(
        (
          await a.client.call("tools/call", {
            name: "publish_artifact",
            arguments: { text: "by-id body", description: "demo" },
          })
        ).content[0].text,
      );
      const read = await a.client.call("resources/read", {
        uri: "launchpad://artifact/" + published.artifact.id,
      });
      expect(read.contents[0].text).toContain("by-id body");
    } finally {
      a.server.kill();
    }
  });

  it("caps wait_for_workers below the MCP client timeout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-mcp-wait-"));
    temporaryDirectories.push(root);
    const data = path.join(root, "data");
    const { createServer } = await import("node:http");
    let seenBody: unknown;
    const coordination = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        seenBody = JSON.parse(body || "{}");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          ok: true,
          completed: false,
          timedOut: true,
          results: [],
          pending: [{ subtaskId: "build", workerRunId: "worker-1" }],
        }));
      });
    });
    await new Promise<void>((resolve) => coordination.listen(0, "127.0.0.1", resolve));
    const address = coordination.address();
    if (!address || typeof address === "string") throw new Error("coordination server did not bind");
    const worker = await spawnWorker(root, data, "run-wait", "run-wait", undefined, {
      LAUNCHPAD_COORDINATION_URL: "http://127.0.0.1:" + address.port,
      LAUNCHPAD_COORDINATION_TOKEN: "token-1",
    });
    try {
      const response = await worker.client.call("tools/call", {
        name: "wait_for_workers",
        arguments: { targets: ["build"], timeout_seconds: 900 },
      });
      const body = JSON.parse(response.content[0].text);
      expect(seenBody).toEqual({ targets: ["build"], timeoutSeconds: 110 });
      expect(body).toMatchObject({
        ok: true,
        completed: false,
        timedOut: true,
        requestedTimeoutSeconds: 900,
        timeoutSeconds: 110,
      });
      expect(body.hint).toContain("Follow pendingHandoffs.suggestedAction before waiting again");
    } finally {
      worker.server.kill();
      await new Promise<void>((resolve, reject) =>
        coordination.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

async function spawnWorker(
  root: string,
  data: string,
  runId: string,
  parentRunId: string,
  commonWorkspace?: string,
  extraEnv: Record<string, string> = {},
) {
  const { mkdir } = await import("node:fs/promises");
  const workspace = path.join(root, "ws-" + runId);
  const codexHome = path.join(root, "codex-home-" + runId);
  await mkdir(workspace, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  const serverPath = path.join(root, "server-" + runId + ".mjs");
  await writeFile(serverPath, LAUNCHPAD_MCP_SERVER_SOURCE, "utf8");
  const server = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      ...(commonWorkspace ? { COMMON_WORKSPACE: commonWorkspace } : {}),
      CODEX_HOME: codexHome,
      LAUNCHPAD_WORKSPACE_PATH: workspace,
      LAUNCHPAD_DATA_DIR: data,
      LAUNCHPAD_AGENT_ID: "agent-" + runId,
      LAUNCHPAD_RUN_ID: runId,
      LAUNCHPAD_PARENT_RUN_ID: parentRunId,
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = jsonRpcClient(server);
  await client.call("initialize", { protocolVersion: "2024-11-05" });
  return { server, client, workspace, codexHome };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function jsonRpcClient(server: ChildProcessWithoutNullStreams) {
  let nextId = 1;
  let stdout = "";
  const pending = new Map<
    number,
    { resolve(value: Record<string, unknown>): void; reject(error: Error): void }
  >();
  server.stdout.setEncoding("utf8");
  server.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    while (true) {
      const index = stdout.indexOf("\n");
      if (index < 0) break;
      const line = stdout.slice(0, index).trim();
      stdout = stdout.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line) as {
        id: number;
        result?: Record<string, unknown>;
        error?: { message?: string };
      };
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result ?? {});
    }
  });
  return {
    call(method: string, params: Record<string, unknown>) {
      const id = nextId++;
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(new Error("MCP call timed out: " + method));
        }, 8_000).unref();
      });
    },
  };
}

describe("shared task state under concurrency", () => {
  it("serialises claims so only one worker wins", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const { LAUNCHPAD_MCP_SERVER_SOURCE } = await import(
      "../src/launchpad-mcp-server-source.js"
    );

    const root = mkdtempSync(join(tmpdir(), "mcp-lock-"));
    const server = join(root, "server.mjs");
    writeFileSync(server, LAUNCHPAD_MCP_SERVER_SOURCE, "utf8");

    // Two workers, one shared parent run: the file they mutate is the same.
    const claim = (agent: string): string => {
      const request =
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05" },
        }) +
        "\n" +
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "claim_task", arguments: { task_id: "shared" } },
        }) +
        "\n";
      return execFileSync(process.execPath, [server], {
        input: request,
        encoding: "utf8",
        env: {
          ...process.env,
          LAUNCHPAD_DATA_DIR: join(root, "data"),
          LAUNCHPAD_WORKSPACE_PATH: root,
          LAUNCHPAD_AGENT_ID: agent,
          LAUNCHPAD_RUN_ID: "run-" + agent,
          LAUNCHPAD_PARENT_RUN_ID: "leader-1",
        },
      });
    };

    const first = claim("agent-a");
    const second = claim("agent-b");

    expect(first).toContain("agent-a");
    expect(first).toContain("claimed");
    // The second sees the taken state rather than overwriting the claimant.
    expect(second).toContain("TASK_ALREADY_CLAIMED");
    expect(second).not.toContain("agent-b\\\",");
  }, 30_000);
});

describe("coordination tools", () => {
  const listTools = async (
    env: Record<string, string> = {},
  ): Promise<{ name: string; description: string }[]> => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const { LAUNCHPAD_MCP_SERVER_SOURCE } = await import(
      "../src/launchpad-mcp-server-source.js"
    );
    const root = mkdtempSync(join(tmpdir(), "mcp-coord-"));
    const server = join(root, "server.mjs");
    writeFileSync(server, LAUNCHPAD_MCP_SERVER_SOURCE, "utf8");
    const out = execFileSync(process.execPath, [server], {
      env: { ...process.env, ...env },
      input:
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) +
        "\n",
      encoding: "utf8",
    });
    const last = out.trim().split("\n").at(-1) ?? "{}";
    return JSON.parse(last).result.tools as { name: string; description: string }[];
  };

  it("exposes the two delivery kinds as separate tools", async () => {
    const names = (await listTools()).map((t) => t.name);
    expect(names).toContain("send_message");
    expect(names).toContain("followup_task");
    expect(names).toContain("list_teammates");
    expect(names).toContain("dispatch_subagent");
  });

  // Waking costs a model turn. If the description does not make that plain the
  // model has no basis to choose, and every note becomes a wakeup.
  it("tells the model which delivery costs a turn", async () => {
    const tools = await listTools();
    const quiet = tools.find((t) => t.name === "send_message");
    const wake = tools.find((t) => t.name === "followup_task");
    expect(quiet?.description).toMatch(/does not wake|no model turn/i);
    expect(wake?.description).toMatch(/costs a model turn/i);
  });

  // A worker that polls its inbox burns turns discovering nothing changed;
  // delivery is pushed, so the tool stays out of the model's reach.
  it("keeps read_inbox out of the model's tool set", async () => {
    expect((await listTools()).map((t) => t.name)).not.toContain("read_inbox");
  });

  it("trims normal worker tool catalogs by role", async () => {
    const researchNames = (await listTools({
      LAUNCHPAD_RUN_ID: "worker-1",
      LAUNCHPAD_PARENT_RUN_ID: "leader-1",
      LAUNCHPAD_AGENT_ROLE: "researcher",
    })).map((t) => t.name);

    expect(researchNames).toContain("web_search");
    expect(researchNames).toContain("fetch_webpage");
    expect(researchNames).toContain("read_many_files");
    expect(researchNames).toContain("batch_tool_call");
    expect(researchNames).not.toContain("dispatch_subagent");
    expect(researchNames).not.toContain("wait_for_workers");
    expect(researchNames).not.toContain("publish_skill");
    expect(researchNames).not.toContain("update_skill_wiki");

    const testerNames = (await listTools({
      LAUNCHPAD_RUN_ID: "worker-2",
      LAUNCHPAD_PARENT_RUN_ID: "leader-1",
      LAUNCHPAD_AGENT_ROLE: "forward-tester",
    })).map((t) => t.name);
    expect(testerNames).toContain("validate_skill");
    expect(testerNames).toContain("browser_snapshot");
    expect(testerNames).not.toContain("dispatch_subagent");
    expect(testerNames).not.toContain("publish_skill");
  });

  it("exposes bounded contract declarations on dispatch_subagent and omits gate, verifier, permission, timeout, and budget fields", async () => {
    const tools = await listTools();
    const dispatch = tools.find((tool) => tool.name === "dispatch_subagent") as {
      name: string;
      inputSchema: { properties: Record<string, unknown> };
    };
    const properties = Object.keys(dispatch.inputSchema.properties);
    expect(properties).toEqual(
      expect.arrayContaining(["contractKey", "inputs", "outputs", "mutationPaths"]),
    );
    for (const key of FORBIDDEN_LEADER_CONTRACT_KEYS) {
      expect(properties).not.toContain(key);
    }
  });

  it("enforces the exact repair-candidate allowlist for direct, searched, delegated, and batched calls", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-mcp-repair-"));
    temporaryDirectories.push(root);
    const common = path.join(root, "common");
    const data = path.join(root, "data");
    await mkdir(common, { recursive: true });
    const spawned = await spawnWorker(root, data, "repair-1", "leader-1", common, {
      LAUNCHPAD_REPAIR_CANDIDATE: "1",
      LAUNCHPAD_REPAIR_ALLOWED_TOOLS: JSON.stringify(["read_file"]),
      LAUNCHPAD_COORDINATION_URL: "http://127.0.0.1:9",
      LAUNCHPAD_COORDINATION_TOKEN: "secret",
    });
    try {
      const listed = await spawned.client.call("tools/list", {});
      const names = listed.tools.map((tool: { name: string }) => tool.name);
      for (const excluded of [
        "dispatch_subagent",
        "inspect_worker_progress",
        "extend_worker_timeout",
        "bootstrap_context",
        "start_job",
        "list_jobs",
        "read_job_output",
        "wait_job",
        "cancel_job",
        "send_message",
        "talk",
        "followup_task",
      ]) {
        expect(names).not.toContain(excluded);
      }
      expect(names).toContain("read_file");
      expect(names).not.toContain("search_files");
      expect(names).not.toContain("list_files");
      expect(names).not.toContain("batch_tool_call");

      const direct = JSON.parse(
        (
          await spawned.client.call("tools/call", {
            name: "search_files",
            arguments: { query: "secret" },
          })
        ).content[0].text,
      );
      expect(direct.ok).toBe(false);

      const searched = JSON.parse(
        (
          await spawned.client.call("tools/call", {
            name: "tool_search",
            arguments: { query: "search files", limit: 20 },
          })
        ).content[0].text,
      );
      expect(JSON.stringify(searched)).not.toContain('"name":"search_files"');

      const delegated = JSON.parse(
        (
          await spawned.client.call("tools/call", {
            name: "tool_call",
            arguments: { tool_name: "list_files", arguments: {} },
          })
        ).content[0].text,
      );
      expect(delegated.ok).toBe(false);

      const inspect = JSON.parse(
        (
          await spawned.client.call("tools/call", {
            name: "inspect_worker_progress",
            arguments: { target: "worker-1" },
          })
        ).content[0].text,
      );
      expect(inspect.ok).toBe(false);

      const batched = JSON.parse(
        (
          await spawned.client.call("tools/call", {
            name: "batch_tool_call",
            arguments: {
              calls: [{ tool_name: "start_job", arguments: { command: "echo leaked" } }],
            },
          })
        ).content[0].text,
      );
      expect(batched.ok).toBe(false);
      expect(JSON.stringify(batched)).toMatch(/batch_tool_call|excluded|repair|allowlist/i);

      const timeout = JSON.parse(
        (
          await spawned.client.call("tools/call", {
            name: "extend_worker_timeout",
            arguments: { target: "worker-1", additional_seconds: 30 },
          })
        ).content[0].text,
      );
      expect(timeout.ok).toBe(false);

      const listedCommon = JSON.parse(
        (
          await spawned.client.call("tools/call", {
            name: "list_files",
            arguments: { path: "$COMMON_WORKSPACE" },
          })
        ).content[0].text,
      );
      expect(listedCommon.ok).toBe(false);
    } finally {
      spawned.server.kill();
    }
  });
});
