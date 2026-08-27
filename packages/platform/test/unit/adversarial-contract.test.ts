import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli, type CliIo } from "../../src/cli.js";
import { commandOnDisk } from "../../src/lib/adversarial/checkers.js";
import { applyFindingContract, FINDING_CAP } from "../../src/lib/adversarial/contract.js";
import { extractCommands } from "../../src/lib/adversarial/parse.js";
import { adversarialReview } from "../../src/lib/adversarial/review.js";
import type { Finding } from "../../src/lib/adversarial/types.js";
import { createContext } from "../../src/lib/context.js";
import { PlatformError } from "../../src/lib/errors.js";
import { playbookRecord } from "../../src/lib/playbook/store.js";

const dirs: string[] = [];
const fixtureDir = fileURLToPath(new URL("../fixtures/plans", import.meta.url));
const fakeCbmDir = fileURLToPath(new URL("../fixtures/fake-cbm", import.meta.url));
const fakeCbmBin = join(fakeCbmDir, "codebase-memory-mcp");

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
  const dir = tmp("devkit-ar-repo-");
  git(dir, ["init"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"]);
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "ok.ts"), "export {}\n");
  return dir;
}

function isolatedEnv(dataRoot: string, extra: { withFakeCbm?: boolean } = {}): NodeJS.ProcessEnv {
  const home = tmp("devkit-home-");
  const pathParts = extra.withFakeCbm
    ? [fakeCbmDir, dirname(process.execPath), "/usr/bin", "/bin"]
    : [dirname(process.execPath), "/usr/bin", "/bin"];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVKIT_DATA_DIR: dataRoot,
    XDG_CONFIG_HOME: tmp("devkit-xdg-"),
    HOME: home,
    USERPROFILE: home,
    PATH: pathParts.join(delimiter),
    FAKE_CBM_STATE: join(tmp("fake-cbm-state-"), "state.json"),
  };
  delete env.DEVKIT_CBM_BINARY;
  delete env.DEVKIT_VERIFICATION;
  delete env.DEVKIT_CONFIG;
  delete env.DEVKIT_PATH;
  delete env.DEVKIT_PLAYBOOK_RESET;
  delete env.CODEX_HOME;
  return env;
}

function silentIo(): CliIo {
  return {
    stdout: { write: () => true } as unknown as NodeJS.WritableStream,
    stderr: { write: () => true } as unknown as NodeJS.WritableStream,
  };
}

function putPlan(repo: string, name: string): string {
  const dest = join(repo, name);
  copyFileSync(join(fixtureDir, name), dest);
  return dest;
}

function finding(partial: Partial<Finding> & Pick<Finding, "tag" | "evidence_type">): Finding {
  return {
    id: "tmp",
    category: partial.category ?? "x",
    claim: partial.claim ?? "c",
    evidence: partial.evidence ?? "e",
    plan_target: partial.plan_target ?? "t",
    patch: partial.patch ?? null,
    ...partial,
  };
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-AR-01 Finding tag=block evidence_type=none is dropped; not in verdict", () => {
  const out = applyFindingContract([
    finding({ tag: "block", evidence_type: "none", claim: "illegal block" }),
    finding({
      tag: "patch-plan",
      evidence_type: "none",
      category: "path",
      claim: "illegal patch",
    }),
    finding({ tag: "note", evidence_type: "none", category: "n", claim: "kept note" }),
  ]);
  assert.equal(out.dropped_illegal, 2);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0]?.tag, "note");
  assert.equal(out.findings[0]?.evidence_type, "none");
  assert.equal(out.verdict, "PASS");
  assert.equal(
    out.findings.some((f) => f.tag === "block"),
    false,
  );
  assert.equal(
    out.findings.some((f) => f.tag === "patch-plan"),
    false,
  );
});

test("T-AR-02 One legal block gives verdict BLOCK", () => {
  const out = applyFindingContract([
    finding({
      tag: "block",
      evidence_type: "filesystem",
      category: "section",
      claim: "Plan has no numbered steps",
    }),
  ]);
  assert.equal(out.dropped_illegal, 0);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0]?.tag, "block");
  assert.equal(out.verdict, "BLOCK");
});

test("T-AR-03 Only patch-plan with filesystem evidence gives PATCH", () => {
  const out = applyFindingContract([
    finding({
      tag: "patch-plan",
      evidence_type: "filesystem",
      category: "path",
      claim: "Path src/a.ts is not on disk",
      patch: "src/ok.ts",
    }),
  ]);
  assert.equal(out.dropped_illegal, 0);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0]?.tag, "patch-plan");
  assert.equal(out.findings[0]?.evidence_type, "filesystem");
  assert.equal(out.verdict, "PATCH");
});

test("T-AR-04 Empty legal findings give PASS", () => {
  const empty = applyFindingContract([]);
  assert.equal(empty.verdict, "PASS");
  assert.equal(empty.findings.length, 0);
  assert.equal(empty.dropped_illegal, 0);

  const onlyIllegal = applyFindingContract([finding({ tag: "block", evidence_type: "none" })]);
  assert.equal(onlyIllegal.verdict, "PASS");
  assert.equal(onlyIllegal.findings.length, 0);
  assert.equal(onlyIllegal.dropped_illegal, 1);
});

test("T-AR-05 Findings capped at 7", () => {
  const rows: Finding[] = [];
  for (let i = 0; i < 5; i++) {
    rows.push(
      finding({
        tag: "block",
        evidence_type: "filesystem",
        category: "path",
        claim: `b${i}`,
      }),
    );
  }
  for (let i = 0; i < 5; i++) {
    rows.push(
      finding({
        tag: "patch-plan",
        evidence_type: "filesystem",
        category: "path",
        claim: `p${i}`,
        patch: "x",
      }),
    );
  }
  for (let i = 0; i < 5; i++) {
    rows.push(
      finding({
        tag: "note",
        evidence_type: "graph",
        category: "symbol",
        claim: `n${i}`,
      }),
    );
  }
  const out = applyFindingContract(rows);
  assert.equal(out.findings.length, FINDING_CAP);
  assert.equal(out.findings.length, 7);
  assert.equal(out.dropped_illegal, 0);
  assert.equal(out.findings.filter((f) => f.tag === "block").length, 5);
  assert.equal(out.findings.filter((f) => f.tag === "patch-plan").length, 2);
  assert.equal(out.findings.filter((f) => f.tag === "note").length, 0);
  assert.deepEqual(
    out.findings.map((f) => f.id),
    ["AR-001", "AR-002", "AR-003", "AR-004", "AR-005", "AR-006", "AR-007"],
  );
  assert.equal(out.verdict, "BLOCK");
});

test("review at resolved_level off returns PASS and does not scan", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({
    repoPath: repo,
    env: isolatedEnv(dataRoot),
    verification: "off",
  });
  const out = await adversarialReview(ctx, { plan_path: "missing-not-scanned.md" });
  assert.equal(out.verdict, "PASS");
  assert.deepEqual(out.findings, []);
  assert.equal(out.dropped_illegal, 0);
  assert.equal(out.graph_ready, false);
  assert.equal(out.resolved_level, "off");
  assert.equal(out.plan_path, "missing-not-scanned.md");
});

test("review PASS on a plan with steps and existing paths", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const plan = putPlan(repo, "pass.md");
  const before = readFileSync(plan, "utf8");
  const mtime = statSync(plan).mtimeMs;
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  const out = await adversarialReview(ctx, { plan_path: "pass.md" });
  assert.equal(out.verdict, "PASS");
  assert.equal(out.findings.length, 0);
  assert.equal(out.resolved_level, "light");
  assert.equal(out.plan_path, realpathSync(plan));
  assert.equal(readFileSync(plan, "utf8"), before);
  assert.equal(statSync(plan).mtimeMs, mtime);
});

test("review BLOCK when the plan has no numbered steps", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  putPlan(repo, "no-steps.md");
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  const out = await adversarialReview(ctx, { plan_path: "no-steps.md" });
  assert.equal(out.verdict, "BLOCK");
  assert.equal(out.findings[0]?.tag, "block");
  assert.equal(out.findings[0]?.evidence_type, "filesystem");
  assert.equal(out.findings[0]?.category, "section");
  assert.equal(
    out.findings.some((f) => f.evidence_type === "none"),
    false,
  );
});

test("review BLOCK when a cited path is missing and graph is down", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  putPlan(repo, "missing-path.md");
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  const out = await adversarialReview(ctx, { plan_path: "missing-path.md" });
  assert.equal(out.verdict, "BLOCK");
  assert.equal(out.graph_ready, false);
  const pathHit = out.findings.find((f) => f.category === "path");
  assert.equal(pathHit?.tag, "block");
  assert.equal(pathHit?.evidence_type, "filesystem");
  assert.equal(pathHit?.plan_target, "src/missing.ts");
});

test("review PATCH when a missing command has a playbook pass key", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  putPlan(repo, "missing-cmd.md");
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  const stored = await playbookRecord(ctx, {
    raw_command: "npm test",
    tool_name: "Bash",
    cwd: repo,
    exit_code: 0,
    duration_ms: 12,
  });
  assert.equal(stored.result, "stored");
  const out = await adversarialReview(ctx, { plan_path: "missing-cmd.md" });
  assert.equal(out.verdict, "PATCH");
  const cmd = out.findings.find((f) => f.category === "command");
  assert.equal(cmd?.tag, "patch-plan");
  assert.equal(cmd?.evidence_type, "playbook");
  assert.equal(cmd?.patch, "npm test");
});

test("review BLOCK when a missing command has no playbook pass key", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  putPlan(repo, "missing-cmd.md");
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  const out = await adversarialReview(ctx, { plan_path: "missing-cmd.md" });
  assert.equal(out.verdict, "BLOCK");
  const cmd = out.findings.find((f) => f.category === "command");
  assert.equal(cmd?.tag, "block");
  assert.equal(cmd?.evidence_type, "filesystem");
});

test("review skips graph symbols when graph is down and does not invent none+block", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  putPlan(repo, "symbols.md");
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  const out = await adversarialReview(ctx, { plan_path: "symbols.md" });
  assert.equal(out.graph_ready, false);
  assert.equal(
    out.findings.some((f) => f.category === "symbol"),
    false,
  );
  assert.equal(
    out.findings.some((f) => f.tag === "block" && f.evidence_type === "none"),
    false,
  );
  assert.equal(out.verdict, "PASS");
});

test("review caps filesystem path findings at 7", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  putPlan(repo, "many-missing.md");
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  const out = await adversarialReview(ctx, { plan_path: "many-missing.md" });
  assert.equal(out.findings.length, 7);
  assert.equal(out.verdict, "BLOCK");
  assert.equal(out.dropped_illegal, 0);
});

test("review rejects plan_path outside the repo", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const outside = join(tmp("devkit-ar-out-"), "plan.md");
  writeFileSync(outside, "# Plan\n\n1. Step.\n");
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  await assert.rejects(
    () => adversarialReview(ctx, { plan_path: outside }),
    (err: unknown) => {
      assert.equal(err instanceof PlatformError, true);
      assert.equal((err as PlatformError).code, "usage");
      return true;
    },
  );
});

test("review rejects plan_path that is not .md", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const txt = join(repo, "plan.txt");
  writeFileSync(txt, "# Plan\n\n1. Step.\n");
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  await assert.rejects(
    () => adversarialReview(ctx, { plan_path: "plan.txt" }),
    (err: unknown) => {
      assert.equal(err instanceof PlatformError, true);
      assert.equal((err as PlatformError).code, "usage");
      return true;
    },
  );
});

test("bullet Test: prose is not a command finding", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const plan = putPlan(repo, "pass.md");
  const text = readFileSync(plan, "utf8");
  assert.match(text, /^- Test: add coverage$/m);
  assert.deepEqual(extractCommands(text), []);
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  const out = await adversarialReview(ctx, { plan_path: "pass.md" });
  assert.equal(out.verdict, "PASS");
  assert.equal(
    out.findings.some((f) => f.category === "command"),
    false,
  );
});

test("review PATCH when graph has a similar path for a missing basename", async () => {
  chmodSync(fakeCbmBin, 0o755);
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  putPlan(repo, "similar-path.md");
  const env = isolatedEnv(dataRoot, { withFakeCbm: true });
  const code = await runCli(["node", "devkit", "--path", repo, "init"], env, silentIo());
  assert.equal(code, 0);
  const ctx = await createContext({ repoPath: repo, env });
  const out = await adversarialReview(ctx, { plan_path: "similar-path.md" });
  assert.equal(out.graph_ready, true);
  assert.equal(out.verdict, "PATCH");
  const pathHit = out.findings.find((f) => f.category === "path");
  assert.equal(pathHit?.tag, "patch-plan");
  assert.equal(pathHit?.evidence_type, "graph");
  assert.equal(pathHit?.plan_target, "ok.ts");
  assert.equal(pathHit?.patch, "src/ok.ts");
  const argv = (
    JSON.parse(readFileSync(env.FAKE_CBM_STATE as string, "utf8")) as { last_argv?: string[] }
  ).last_argv;
  assert.ok(Array.isArray(argv));
  assert.equal(argv.includes("--query"), false);
  assert.equal(argv.includes("--name-pattern"), false);
  assert.equal(argv.includes("--file-pattern"), true);
});

test("commandOnDisk treats absolute PATH binaries as executable", () => {
  const repo = makeRepo();
  const env = isolatedEnv(tmp("devkit-data-"));
  assert.equal(commandOnDisk(process.execPath, repo, env), true);
  assert.equal(commandOnDisk("/no/such/coredevkit-bin", repo, env), false);
});

test("commandOnDisk requires +x for relative scripts inside the repo", () => {
  const repo = makeRepo();
  const env = isolatedEnv(tmp("devkit-data-"));
  mkdirSync(join(repo, "scripts"));
  const script = join(repo, "scripts", "check.sh");
  writeFileSync(script, "#!/bin/sh\nexit 0\n");
  chmodSync(script, 0o644);
  assert.equal(commandOnDisk("./scripts/check.sh", repo, env), false);
  chmodSync(script, 0o755);
  assert.equal(commandOnDisk("./scripts/check.sh", repo, env), true);
});

test("review PASS when the plan cites an absolute executable", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  writeFileSync(
    join(repo, "abs.md"),
    `# Plan\n\n1. Run the helper.\n2. Keep \`src/ok.ts\`.\n\nrun: ${process.execPath}\n`,
  );
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  const out = await adversarialReview(ctx, { plan_path: "abs.md" });
  assert.equal(out.verdict, "PASS");
  assert.equal(
    out.findings.some((f) => f.category === "command"),
    false,
  );
});

test("review rejects a missing plan outside the repo as usage", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const outside = join(tmp("devkit-ar-out-"), "missing.md");
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  await assert.rejects(
    () => adversarialReview(ctx, { plan_path: outside }),
    (err: unknown) => {
      assert.equal(err instanceof PlatformError, true);
      assert.equal((err as PlatformError).code, "usage");
      return true;
    },
  );
});

test("review rejects a symlink that leaves the repo", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const outside = join(tmp("devkit-ar-out-"), "plan.md");
  writeFileSync(outside, "# Plan\n\n1. Step.\n");
  symlinkSync(outside, join(repo, "link.md"));
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  await assert.rejects(
    () => adversarialReview(ctx, { plan_path: "link.md" }),
    (err: unknown) => {
      assert.equal(err instanceof PlatformError, true);
      assert.equal((err as PlatformError).code, "usage");
      return true;
    },
  );
});

test("review returns not_found for a missing in-repo plan", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  await assert.rejects(
    () => adversarialReview(ctx, { plan_path: "gone.md" }),
    (err: unknown) => {
      assert.equal(err instanceof PlatformError, true);
      assert.equal((err as PlatformError).code, "not_found");
      return true;
    },
  );
});

test("review accepts a plan.md under DEVKIT_HOME/plans", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  const planDir = join(ctx.paths.plansDir, "wt");
  mkdirSync(planDir, { recursive: true });
  const plan = join(planDir, "plan.md");
  copyFileSync(join(fixtureDir, "pass.md"), plan);
  const out = await adversarialReview(ctx, { plan_path: plan });
  assert.equal(out.plan_path, realpathSync(plan));
  assert.equal(out.verdict, "PASS");
});

test("review rejects a plan.md under other user-data trees", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const ctx = await createContext({ repoPath: repo, env: isolatedEnv(dataRoot) });
  mkdirSync(ctx.paths.playbookDir, { recursive: true });
  const outsidePlans = join(ctx.paths.playbookDir, "plan.md");
  writeFileSync(outsidePlans, "# Plan\n\n1. Step.\n");
  await assert.rejects(
    () => adversarialReview(ctx, { plan_path: outsidePlans }),
    (err: unknown) => {
      assert.equal(err instanceof PlatformError, true);
      assert.equal((err as PlatformError).code, "usage");
      return true;
    },
  );
});
