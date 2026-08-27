import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runCli, type CliIo } from "../../src/cli.js";
import { createContext } from "../../src/lib/context.js";
import { PlatformError } from "../../src/lib/errors.js";
import { hasForbiddenDir } from "../../src/lib/tune/jail.js";
import {
  ingestProgress,
  listProposals,
  overrideMdPath,
  proposeFromSignals,
  recordSignal,
  tuneAccept,
  tuneReject,
  tuneRevert,
  tuneShow,
  tuneStatus,
  writeProposal,
  type Proposal,
  type Signal,
} from "../../src/lib/tune/store.js";
import { createMcpServer } from "../../src/mcp.js";

const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "init.defaultBranch=main", ...args], {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

function makeRepo(): string {
  const dir = tmp("devkit-tn-repo-");
  git(dir, ["init"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"]);
  return dir;
}

function isolatedEnv(dataRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVKIT_DATA_DIR: dataRoot,
    XDG_CONFIG_HOME: tmp("devkit-xdg-"),
  };
  delete env.DEVKIT_PLAYBOOK_RESET;
  return env;
}

function captureIo(): { io: CliIo; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: {
        write: (s: string) => {
          out += String(s);
          return true;
        },
      } as unknown as NodeJS.WritableStream,
      stderr: {
        write: (s: string) => {
          err += String(s);
          return true;
        },
      } as unknown as NodeJS.WritableStream,
    },
    out: () => out,
    err: () => err,
  };
}

const SAMPLE_FACT = {
  purpose: "test",
  failed_key: "npm test",
  success_key: "pnpm test",
};

function sampleSignal(): Signal {
  return {
    at: "2026-08-26T00:00:00.000Z",
    kind: "evidence_fail_then_success",
    fact: { ...SAMPLE_FACT },
  };
}

function plantProposal(
  ctx: Awaited<ReturnType<typeof createContext>>,
  extra: Partial<Proposal> = {},
): Proposal {
  const proposal: Proposal = {
    id: extra.id ?? "tp-20260826-abcd1234",
    skill: extra.skill ?? "using-coredevkit",
    created_at: extra.created_at ?? "2026-08-26T00:00:00.000Z",
    status: extra.status ?? "pending",
    source_facts: extra.source_facts ?? [sampleSignal()],
    repeats: extra.repeats ?? 2,
    window_runs: extra.window_runs ?? 20,
    override_md: extra.override_md ?? "# Personal override\n\n- Prefer command `pnpm test`.\n",
  };
  mkdirSync(ctx.paths.proposalsDir, { recursive: true });
  writeFileSync(
    join(ctx.paths.proposalsDir, `${proposal.id}.json`),
    `${JSON.stringify(proposal)}\n`,
  );
  return proposal;
}

function listMd(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) {
      continue;
    }
    for (const name of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, name.name);
      if (name.isDirectory()) {
        stack.push(p);
      } else if (name.name.endsWith(".md") || name.name === "SKILL.md") {
        out.push(p);
      }
    }
  }
  return out;
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-TN-01 tune_accept path escapes to plugins and marketplace and is not written", async () => {
  assert.equal(hasForbiddenDir("/tmp/app/plugins/skill/SKILL.md"), true);
  assert.equal(hasForbiddenDir("/tmp/app/marketplace/skill/SKILL.md"), true);
  assert.equal(hasForbiddenDir("/tmp/app/node_modules/pkg/SKILL.md"), true);
  assert.equal(hasForbiddenDir("/tmp/app/.claude/plugins/x/SKILL.md"), true);
  assert.equal(hasForbiddenDir("/tmp/app/Plugins/skill/SKILL.md"), true);
  assert.equal(hasForbiddenDir("/tmp/app/.claude/Plugins/x/SKILL.md"), true);
  assert.equal(hasForbiddenDir("/tmp/app/NODE_MODULES/pkg/SKILL.md"), true);
  assert.equal(hasForbiddenDir("/tmp/devkit/overrides/id/plugins.override.md"), false);

  for (const banned of ["plugins", "marketplace", "node_modules", "Plugins"] as const) {
    const root = tmp("devkit-tn-root-");
    const dataRoot = join(root, banned, "data");
    mkdirSync(dataRoot, { recursive: true });
    const repo = makeRepo();
    const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
    const planted = plantProposal(ctx);
    const bannedTree = join(root, banned);
    const before = listMd(bannedTree);
    await assert.rejects(
      () => tuneAccept(ctx, planted.id),
      (err: unknown) =>
        err instanceof PlatformError && (err.code === "denied" || err.code === "usage"),
    );
    assert.equal(existsSync(overrideMdPath(ctx, planted.skill)), false);
    const after = listMd(bannedTree);
    assert.deepEqual(after, before);
  }

  const dataRoot = tmp("devkit-tn-data-");
  const repo = makeRepo();
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  const plugins = join(tmp("devkit-tn-plug-"), "plugins", "market");
  mkdirSync(plugins, { recursive: true });
  const planted = plantProposal(ctx, { skill: "../../plugins/evil" });
  await assert.rejects(
    () => tuneAccept(ctx, planted.id),
    (err: unknown) =>
      err instanceof PlatformError && (err.code === "denied" || err.code === "usage"),
  );
  assert.equal(existsSync(join(plugins, "evil.override.md")), false);
  assert.equal(existsSync(join(plugins, "evil", "SKILL.md")), false);
  assert.equal(
    existsSync(join(ctx.paths.overridesDir, "..", "..", "plugins", "evil.override.md")),
    false,
  );

  const realOverrides = ctx.paths.overridesDir;
  const aside = `${realOverrides}.aside`;
  renameSync(realOverrides, aside);
  mkdirSync(plugins, { recursive: true });
  writeFileSync(join(plugins, "tp-keep.json"), "x");
  symlinkSync(plugins, realOverrides);
  const viaLink = plantProposal(
    { ...ctx, paths: { ...ctx.paths, proposalsDir: join(plugins, "proposals") } },
    { id: "tp-20260826-eeeeffff", skill: "using-coredevkit" },
  );
  await assert.rejects(
    () => tuneAccept(ctx, viaLink.id),
    (err: unknown) => err instanceof PlatformError && err.code === "denied",
  );
  assert.equal(existsSync(join(plugins, "using-coredevkit.override.md")), false);
  assert.equal(listMd(plugins).length, 0);

  const claudeRoot = tmp("devkit-tn-claude-");
  const claudeData = join(claudeRoot, ".claude", "Plugins", "data");
  mkdirSync(claudeData, { recursive: true });
  const claudeCtx = await createContext({
    repoPath: makeRepo(),
    env: isolatedEnv(claudeData),
  });
  const claudePlanted = plantProposal(claudeCtx);
  await assert.rejects(
    () => tuneAccept(claudeCtx, claudePlanted.id),
    (err: unknown) =>
      err instanceof PlatformError && (err.code === "denied" || err.code === "usage"),
  );
  assert.equal(existsSync(overrideMdPath(claudeCtx, claudePlanted.skill)), false);

  const dataRoot2 = tmp("devkit-tn-data-");
  const ctx2 = await createContext({ repoPath: makeRepo(), env: isolatedEnv(dataRoot2) });
  const planted2 = plantProposal(ctx2, { id: "tp-20260826-aaaabbbb" });
  const outside = tmp("devkit-tn-out-");
  const aside2 = `${ctx2.paths.overridesDir}.aside`;
  renameSync(ctx2.paths.overridesDir, aside2);
  symlinkSync(outside, ctx2.paths.overridesDir);
  mkdirSync(join(outside, "proposals"), { recursive: true });
  writeFileSync(
    join(outside, "proposals", `${planted2.id}.json`),
    readFileSync(join(aside2, "proposals", `${planted2.id}.json`)),
  );
  await assert.rejects(
    () => tuneAccept(ctx2, planted2.id),
    (err: unknown) => err instanceof PlatformError && err.code === "denied",
  );
  assert.equal(existsSync(join(outside, "using-coredevkit.override.md")), false);
});

test("T-TN-02 proposal without source_facts is not written", async () => {
  const dataRoot = tmp("devkit-tn-data-");
  const repo = makeRepo();
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  const id = "tp-20260826-0000aaaa";
  const wrote = writeProposal(ctx, {
    id,
    skill: "using-coredevkit",
    created_at: "2026-08-26T00:00:00.000Z",
    status: "pending",
    source_facts: [],
    repeats: 2,
    window_runs: 20,
    override_md: "# Personal override\n",
  });
  assert.equal(wrote, undefined);
  assert.equal(existsSync(join(ctx.paths.proposalsDir, `${id}.json`)), false);
  assert.equal(existsSync(ctx.paths.proposalsDir), false);

  const wroteBad = writeProposal(ctx, {
    id: "tp-20260826-0000bbbb",
    skill: "using-coredevkit",
    created_at: "2026-08-26T00:00:00.000Z",
    status: "pending",
    source_facts: [
      {
        at: "2026-08-26T00:00:00.000Z",
        kind: "evidence_fail_then_success",
        fact: {},
      },
    ],
    repeats: 2,
    window_runs: 20,
    override_md: "# Personal override\n",
  });
  assert.equal(wroteBad, undefined);
  assert.equal(existsSync(join(ctx.paths.proposalsDir, "tp-20260826-0000bbbb.json")), false);
});

test("min_repeats and window_runs gate proposals and auto_accept stays false", async () => {
  const dataRoot = tmp("devkit-tn-data-");
  const repo = makeRepo();
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  assert.equal(ctx.config.tuning.auto_accept, false);
  assert.equal(ctx.config.tuning.min_repeats, 2);
  assert.equal(ctx.config.tuning.window_runs, 20);

  await recordSignal(ctx, { kind: "evidence_fail_then_success", fact: SAMPLE_FACT });
  let status = await tuneStatus(ctx);
  assert.deepEqual(status.pending, []);
  assert.equal(status.auto_accept, false);
  assert.equal(
    existsSync(ctx.paths.proposalsDir) && readdirSync(ctx.paths.proposalsDir).length > 0,
    false,
  );

  await recordSignal(ctx, { kind: "evidence_fail_then_success", fact: SAMPLE_FACT });
  status = await tuneStatus(ctx);
  assert.equal(status.pending.length, 1);
  assert.equal(status.auto_accept, false);
  const id = status.pending[0];
  assert.ok(id);
  const shown = await tuneShow(ctx, id);
  assert.ok(shown.source_facts.length >= 2);
  assert.equal(existsSync(overrideMdPath(ctx, shown.skill)), false);

  const cfg = join(tmp("devkit-tn-cfg-"), "cfg.yaml");
  writeFileSync(cfg, "tuning:\n  min_repeats: 2\n  window_runs: 1\n");
  const narrow = await createContext({
    repoPath: makeRepo(),
    configFile: cfg,
    env: isolatedEnv(tmp("devkit-tn-data-")),
  });
  await recordSignal(narrow, { kind: "evidence_fail_then_success", fact: SAMPLE_FACT });
  await recordSignal(narrow, { kind: "evidence_fail_then_success", fact: SAMPLE_FACT });
  const narrowStatus = await tuneStatus(narrow);
  assert.deepEqual(narrowStatus.pending, []);
});

test("accept writes override under user-data; reject and revert do not leak", async () => {
  const dataRoot = tmp("devkit-tn-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const ctx = await createContext({ repoPath: repo, env });
  await recordSignal(ctx, { kind: "evidence_fail_then_success", fact: SAMPLE_FACT });
  await recordSignal(ctx, { kind: "evidence_fail_then_success", fact: SAMPLE_FACT });
  const { pending } = await tuneStatus(ctx);
  const id = pending[0];
  assert.ok(id);

  await tuneReject(ctx, id);
  assert.equal(existsSync(overrideMdPath(ctx, "using-coredevkit")), false);
  const rejected = await tuneShow(ctx, id);
  assert.equal(rejected.status, "rejected");
  await proposeFromSignals(ctx);
  assert.deepEqual((await tuneStatus(ctx)).pending, []);

  const second = plantProposal(ctx, { id: "tp-20260826-ccccdddd" });
  await tuneAccept(ctx, second.id);
  const dest = overrideMdPath(ctx, second.skill);
  assert.equal(existsSync(dest), true);
  assert.equal(dest.startsWith(ctx.paths.overridesDir), true);
  assert.match(readFileSync(dest, "utf8"), /Personal override/);
  const accepted = await tuneShow(ctx, second.id);
  assert.equal(accepted.status, "accepted");
  await proposeFromSignals(ctx);
  assert.equal((await tuneStatus(ctx)).pending.includes(second.id), false);
  assert.equal(listProposals(ctx).filter((p) => p.status === "pending").length, 0);

  await tuneRevert(ctx, second.skill);
  assert.equal(existsSync(dest), false);
  const hist = readdirSync(ctx.paths.historyDir);
  assert.equal(hist.length, 1);
  assert.match(hist[0] ?? "", /^using-coredevkit\.\d+\.md$/);
  const reverted = await tuneShow(ctx, second.id);
  assert.equal(reverted.status, "reverted");
});

test("progress missing step_title or status is dropped and progress is not written", async () => {
  const dataRoot = tmp("devkit-tn-data-");
  const repo = makeRepo();
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  assert.equal(existsSync(ctx.paths.progressDir), false);
  await ingestProgress(ctx);
  await tuneStatus(ctx);
  assert.equal(existsSync(ctx.paths.progressDir), false);

  mkdirSync(ctx.paths.progressDir, { recursive: true });
  writeFileSync(join(ctx.paths.progressDir, "no-title.yaml"), "status: blocked\n");
  writeFileSync(join(ctx.paths.progressDir, "no-status.yaml"), "step_title: run tests\n");
  const names = readdirSync(ctx.paths.progressDir).sort();
  await ingestProgress(ctx);
  assert.deepEqual(readdirSync(ctx.paths.progressDir).sort(), names);
  assert.equal(existsSync(ctx.paths.signalsFile), false);

  writeFileSync(
    join(ctx.paths.progressDir, "ok.json"),
    `${JSON.stringify([
      {
        step_title: "run tests",
        status: "blocked",
        command_key: "npm test",
        resume_step_id: "nope",
      },
      { step_title: "run tests", status: "done", command_key: "pnpm test" },
    ])}\n`,
  );
  await ingestProgress(ctx);
  assert.equal(existsSync(ctx.paths.signalsFile), true);
  const lines = readFileSync(ctx.paths.signalsFile, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const sig = JSON.parse(lines[0] ?? "{}") as Signal;
  assert.equal(sig.kind, "step_blocked_then_completed");
  assert.equal(sig.fact.step_title, "run tests");
  assert.equal(sig.fact.command_key, "pnpm test");
  assert.equal("resume_step_id" in sig.fact, false);
  await ingestProgress(ctx);
  const lines2 = readFileSync(ctx.paths.signalsFile, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(lines2.length, 1);
});

test("auto_accept true writes override once and later propose does not duplicate", async () => {
  const dataRoot = tmp("devkit-tn-data-");
  const repo = makeRepo();
  const cfg = join(tmp("devkit-tn-cfg-"), "cfg.yaml");
  writeFileSync(cfg, "tuning:\n  auto_accept: true\n");
  const ctx = await createContext({
    repoPath: repo,
    configFile: cfg,
    env: isolatedEnv(dataRoot),
  });
  assert.equal(ctx.config.tuning.auto_accept, true);
  await recordSignal(ctx, { kind: "evidence_fail_then_success", fact: SAMPLE_FACT });
  await recordSignal(ctx, { kind: "evidence_fail_then_success", fact: SAMPLE_FACT });
  const dest = overrideMdPath(ctx, "using-coredevkit");
  assert.equal(existsSync(dest), true);
  const rows = listProposals(ctx);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "accepted");
  const status = await tuneStatus(ctx);
  assert.deepEqual(status.pending, []);
  assert.equal(status.auto_accept, true);
  await proposeFromSignals(ctx);
  assert.equal(listProposals(ctx).length, 1);
  assert.equal(listProposals(ctx)[0]?.status, "accepted");
  assert.deepEqual((await tuneStatus(ctx)).pending, []);
});

test("invalid proposal id does not join outside proposalsDir", async () => {
  const dataRoot = tmp("devkit-tn-data-");
  const repo = makeRepo();
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  await assert.rejects(
    () => tuneAccept(ctx, "../../../tmp/x"),
    (err: unknown) => err instanceof PlatformError && err.code === "usage",
  );
  await assert.rejects(
    () => tuneShow(ctx, "../../../tmp/x"),
    (err: unknown) => err instanceof PlatformError && err.code === "usage",
  );
});

test("CLI tune with a bad subcommand does not write user data", async () => {
  const dataRoot = tmp("devkit-tn-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const cap = captureIo();
  assert.equal(await runCli(["node", "devkit", "--path", repo, "tune", "nope"], env, cap.io), 1);
  assert.equal(existsSync(join(dataRoot, "devkit", "playbooks")), false);
  const cap2 = captureIo();
  assert.equal(
    await runCli(
      ["node", "devkit", "--path", repo, "tune", "accept", "../../../tmp/x"],
      env,
      cap2.io,
    ),
    1,
  );
  assert.equal(existsSync(join(dataRoot, "devkit", "playbooks")), false);
});

test("CLI tune status show accept reject revert", async () => {
  const dataRoot = tmp("devkit-tn-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const ctx = await createContext({ repoPath: repo, env });
  await recordSignal(ctx, { kind: "evidence_fail_then_success", fact: SAMPLE_FACT });
  await recordSignal(ctx, { kind: "evidence_fail_then_success", fact: SAMPLE_FACT });
  const id = (await tuneStatus(ctx)).pending[0];
  assert.ok(id);

  const st = captureIo();
  assert.equal(await runCli(["node", "devkit", "--path", repo, "tune", "status"], env, st.io), 0);
  const statusBody = JSON.parse(st.out()) as { pending: string[]; auto_accept: boolean };
  assert.deepEqual(statusBody.pending, [id]);
  assert.equal(statusBody.auto_accept, false);

  const sh = captureIo();
  assert.equal(await runCli(["node", "devkit", "--path", repo, "tune", "show", id], env, sh.io), 0);
  const shown = JSON.parse(sh.out()) as Proposal;
  assert.equal(shown.id, id);
  assert.ok(shown.source_facts.length > 0);

  const rej = captureIo();
  assert.equal(
    await runCli(["node", "devkit", "--path", repo, "tune", "reject", id], env, rej.io),
    0,
  );
  assert.deepEqual(JSON.parse(rej.out()), { ok: true });
  assert.equal(existsSync(overrideMdPath(ctx, "using-coredevkit")), false);

  const planted = plantProposal(ctx, { id: "tp-20260826-1111aaaa" });
  const acc = captureIo();
  assert.equal(
    await runCli(["node", "devkit", "--path", repo, "tune", "accept", planted.id], env, acc.io),
    0,
  );
  assert.deepEqual(JSON.parse(acc.out()), { ok: true });
  assert.equal(existsSync(overrideMdPath(ctx, planted.skill)), true);

  const rev = captureIo();
  assert.equal(
    await runCli(["node", "devkit", "--path", repo, "tune", "revert", planted.skill], env, rev.io),
    0,
  );
  assert.deepEqual(JSON.parse(rev.out()), { ok: true });
  assert.equal(existsSync(overrideMdPath(ctx, planted.skill)), false);

  const bad = captureIo();
  assert.equal(await runCli(["node", "devkit", "--path", repo, "tune", "nope"], env, bad.io), 1);
});

test("MCP tune_status tune_accept and tune_reject", async () => {
  const dataRoot = tmp("devkit-tn-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const ctx = await createContext({ repoPath: repo, env });
  await recordSignal(ctx, { kind: "evidence_fail_then_success", fact: SAMPLE_FACT });
  await recordSignal(ctx, { kind: "evidence_fail_then_success", fact: SAMPLE_FACT });
  const id = (await tuneStatus(ctx)).pending[0];
  assert.ok(id);

  const server = createMcpServer({ cwd: repo, env });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devkit-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    assert.equal(
      listed.tools.some((t) => t.name === "tune_revert"),
      false,
    );
    const status = await client.callTool({ name: "tune_status", arguments: {} });
    assert.equal("isError" in status && Boolean(status.isError), false);
    const statusBody = status.structuredContent as { pending: string[]; auto_accept: boolean };
    assert.ok(statusBody.pending.includes(id));
    assert.equal(statusBody.auto_accept, false);

    const rejected = await client.callTool({
      name: "tune_reject",
      arguments: { proposal_id: id },
    });
    assert.equal("isError" in rejected && Boolean(rejected.isError), false);
    assert.deepEqual(rejected.structuredContent, { ok: true });
    assert.equal(existsSync(overrideMdPath(ctx, "using-coredevkit")), false);

    const planted = plantProposal(ctx, { id: "tp-20260826-2222bbbb" });
    const accepted = await client.callTool({
      name: "tune_accept",
      arguments: { proposal_id: planted.id },
    });
    assert.equal("isError" in accepted && Boolean(accepted.isError), false);
    assert.deepEqual(accepted.structuredContent, { ok: true });
    assert.equal(existsSync(overrideMdPath(ctx, planted.skill)), true);
  } finally {
    await client.close();
    await server.close();
  }
});
