import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AdversarialResult, Finding } from "@coredevkit/platform";
import { createContext } from "@coredevkit/platform";
import {
  parsePluginArgv,
  runPluginCli,
  type PluginCliIo,
} from "../../src/cli.js";
import { loadCoordinator } from "../../src/lib/coordinator/store.js";
import { loadPlatform } from "../../src/lib/platform-guard.js";
import { planFilePaths } from "../../src/lib/plan/paths.js";
import { worktreeHash } from "../../src/lib/worktree.js";

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
  const dir = tmp("devkit-ar-cli-repo-");
  git(dir, ["init"]);
  git(dir, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "--allow-empty",
    "-m",
    "init",
  ]);
  return dir;
}

function isolatedEnv(dataRoot: string): NodeJS.ProcessEnv {
  const home = tmp("devkit-home-");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVKIT_DATA_DIR: dataRoot,
    XDG_CONFIG_HOME: tmp("devkit-xdg-"),
    HOME: home,
    USERPROFILE: home,
  };
  delete env.DEVKIT_CONFIG;
  delete env.DEVKIT_PLAN;
  delete env.DEVKIT_VERIFICATION;
  delete env.DEVKIT_PATH;
  return env;
}

function captureIo(): {
  io: PluginCliIo;
  out: () => string;
  err: () => string;
} {
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

function intentJson(agentPlan: string): string {
  return `${JSON.stringify(
    {
      version: 1,
      title: "Add adversarial",
      summary: "Gate implement.",
      goal: "Add adversarial checkpoint.",
      agent_plan: agentPlan,
      theme_default: "system",
      non_goals: [],
      constraints: [],
      assumptions: [],
      open_questions: [],
      components: [
        { id: "c1", name: "plugin", path: "packages/plugin", role: "lib" },
      ],
      processes: [
        {
          id: "p1",
          title: "Ship gate",
          complete: true,
          steps: [
            {
              id: "PS1",
              title: "Gate",
              detail: "Add checkpoint.",
              required: true,
            },
          ],
        },
      ],
      sequences: [],
      stack: [],
      risks: [],
    },
    null,
    2,
  )}\n`;
}

const PLAN_MD = `# Add adversarial

## Steps

1. **S1: Add checkpoint** — paths \`packages/plugin/src/lib/gates/adversarial.ts\`.
2. **S2: Add auto-patch** — paths \`packages/plugin/src/lib/gates/auto-patch.ts\`.
3. **S3: Add checker** — paths \`packages/plugin/agents/adversarial-checker.md\`.
4. **S4: Add skill** — paths \`packages/plugin/skills/adversarial-checkpoint/SKILL.md\`.

## Stack

none
`;

async function startPlan(
  repo: string,
  env: NodeJS.ProcessEnv,
): Promise<Awaited<ReturnType<typeof createContext>>> {
  const ctx = await createContext({ repoPath: repo, env });
  const wt = worktreeHash(ctx.repoPath);
  const planDir = join(ctx.paths.plansDir, wt.worktree_hash);
  const paths = planFilePaths(planDir);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(paths.intentPath, intentJson(paths.agentPlan));
  writeFileSync(paths.agentPlan, PLAN_MD);
  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "plan", "--start-coordinator"],
    env,
    cap.io,
  );
  assert.equal(code, 0, cap.err());
  return ctx;
}

function finding(
  partial: Partial<Finding> & Pick<Finding, "tag">,
): Finding {
  return {
    id: partial.id ?? "AR-001",
    tag: partial.tag,
    category: partial.category ?? "path",
    claim: partial.claim ?? "claim",
    evidence_type: partial.evidence_type ?? "filesystem",
    evidence: partial.evidence ?? "e",
    plan_target: partial.plan_target ?? "t",
    patch: partial.patch === undefined ? "p" : partial.patch,
  };
}

function mockReview(
  result: Omit<AdversarialResult, "plan_path" | "resolved_level">,
  counts: { review: number },
) {
  return async () => {
    const real = await loadPlatform();
    return new Proxy(real, {
      get(target, prop, recv) {
        if (prop === "adversarialReview") {
          return async (
            ctx: Parameters<typeof real.adversarialReview>[0],
            q: Parameters<typeof real.adversarialReview>[1],
          ) => {
            counts.review += 1;
            return {
              ...result,
              plan_path: q.plan_path,
              resolved_level: ctx.config.resolved_level,
              graph_ready: result.graph_ready,
            };
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });
  };
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parsePluginArgv stores --accept-patch", () => {
  const parsed = parsePluginArgv([
    "node",
    "devkit",
    "implement",
    "--accept-patch",
  ]);
  assert.equal(parsed.pluginCommand, "implement");
  assert.equal(parsed.acceptPatch, true);
});

test("T-AR-P-04 BLOCK exits 2 on packet and mark done", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  const ctx = await startPlan(repo, env);
  const counts = { review: 0 };
  const block = mockReview(
    {
      verdict: "BLOCK",
      findings: [
        finding({
          tag: "block",
          claim: "Plan is unsafe",
          patch: null,
        }),
      ],
      dropped_illegal: 0,
      graph_ready: false,
    },
    counts,
  );

  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "--verification", "full", "implement"],
    env,
    cap.io,
    { loadPlatform: block },
  );
  assert.equal(code, 2, cap.err());
  assert.match(cap.err(), /adversarial BLOCK/);
  assert.equal(cap.out().trim(), "");
  assert.doesNotMatch(cap.out(), /coder/);
  const afterPacket = await loadCoordinator(ctx);
  assert.equal(afterPacket.adversarial.status, "blocked");
  assert.equal(afterPacket.steps[0]?.status, "pending");
  assert.notEqual(afterPacket.steps[0]?.status, "done");
  assert.equal(afterPacket.resume_step_id, "S1");
  assert.ok(counts.review >= 1);

  const capMark = captureIo();
  const codeMark = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "--verification",
      "full",
      "implement",
      "--mark",
      "done",
    ],
    env,
    capMark.io,
    { loadPlatform: block },
  );
  assert.equal(codeMark, 2, capMark.err());
  assert.match(capMark.err(), /adversarial BLOCK/);
  const afterMark = await loadCoordinator(ctx);
  assert.notEqual(afterMark.steps[0]?.status, "done");
  assert.equal(afterMark.adversarial.status, "blocked");
});

test("T-AR-P-05 CLI auto_patch applies eligible patch-plan and marks passed", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  const ctx = await startPlan(repo, env);
  const wt = worktreeHash(ctx.repoPath);
  const paths = planFilePaths(join(ctx.paths.plansDir, wt.worktree_hash));
  const counts = { review: 0 };
  const patch = mockReview(
    {
      verdict: "PATCH",
      findings: [
        finding({
          tag: "patch-plan",
          claim: "Fix title",
          plan_target: "Add adversarial",
          patch: "Add adversarial gate",
          evidence_type: "graph",
        }),
        finding({
          tag: "note",
          claim: "Ignore me",
          plan_target: "## Steps",
          patch: "SHOULD NOT APPLY NOTE",
          evidence_type: "graph",
        }),
      ],
      dropped_illegal: 0,
      graph_ready: false,
    },
    counts,
  );

  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "--verification", "full", "implement"],
    env,
    cap.io,
    { loadPlatform: patch },
  );
  assert.equal(code, 0, cap.err());
  assert.equal(counts.review, 1);
  const rec = await loadCoordinator(ctx);
  assert.equal(rec.adversarial.status, "passed");
  const md = readFileSync(paths.agentPlan, "utf8");
  assert.match(md, /^Add adversarial gate$/m);
  assert.doesNotMatch(md, /SHOULD NOT APPLY NOTE/);
  assert.equal(readFileSync(join(paths.planDir, "plan.md.bak"), "utf8").startsWith("# Add adversarial"), true);
  const packet = JSON.parse(cap.out()) as { dispatch?: { role?: string } | null };
  assert.equal(packet.dispatch?.role, "coder");

  const cap2 = captureIo();
  const code2 = await runPluginCli(
    ["node", "devkit", "--path", repo, "--verification", "full", "implement"],
    env,
    cap2.io,
    { loadPlatform: patch },
  );
  assert.equal(code2, 0, cap2.err());
  assert.equal(counts.review, 1);
});

test("T-AR-P-07 PATCH with auto_patch false waits for --accept-patch", async () => {
  const env = isolatedEnv(tmp("devkit-data-"));
  const repo = makeRepo();
  mkdirSync(join(repo, ".devkit"), { recursive: true });
  writeFileSync(
    join(repo, ".devkit", "config.yaml"),
    "verification:\n  auto_patch: false\n",
  );
  const ctx = await startPlan(repo, env);
  const wt = worktreeHash(ctx.repoPath);
  const paths = planFilePaths(join(ctx.paths.plansDir, wt.worktree_hash));
  const before = readFileSync(paths.agentPlan, "utf8");
  const counts = { review: 0 };
  const patch = mockReview(
    {
      verdict: "PATCH",
      findings: [
        finding({
          tag: "patch-plan",
          claim: "Fix heading",
          plan_target: "Add adversarial",
          patch: "Add adversarial gate",
          evidence_type: "graph",
        }),
      ],
      dropped_illegal: 0,
      graph_ready: false,
    },
    counts,
  );

  const cap = captureIo();
  const code = await runPluginCli(
    ["node", "devkit", "--path", repo, "--verification", "full", "implement"],
    env,
    cap.io,
    { loadPlatform: patch },
  );
  assert.equal(code, 2, cap.err());
  assert.match(cap.err(), /run devkit implement --accept-patch/);
  assert.match(cap.err(), /Fix heading/);
  assert.equal(readFileSync(paths.agentPlan, "utf8"), before);
  const waiting = await loadCoordinator(ctx);
  assert.equal(waiting.adversarial.verdict, "PATCH");
  assert.notEqual(waiting.adversarial.status, "passed");
  assert.notEqual(waiting.adversarial.status, "blocked");
  assert.equal(waiting.steps[0]?.status, "pending");
  assert.equal(counts.review, 1);

  const capWait = captureIo();
  const codeWait = await runPluginCli(
    ["node", "devkit", "--path", repo, "--verification", "full", "implement"],
    env,
    capWait.io,
    { loadPlatform: patch },
  );
  assert.equal(codeWait, 2, capWait.err());
  assert.match(capWait.err(), /run devkit implement --accept-patch/);
  assert.equal(counts.review, 1);
  assert.equal(readFileSync(paths.agentPlan, "utf8"), before);

  const capAccept = captureIo();
  const codeAccept = await runPluginCli(
    [
      "node",
      "devkit",
      "--path",
      repo,
      "--verification",
      "full",
      "implement",
      "--accept-patch",
    ],
    env,
    capAccept.io,
    { loadPlatform: patch },
  );
  assert.equal(codeAccept, 0, capAccept.err());
  assert.equal(counts.review, 1);
  const accepted = await loadCoordinator(ctx);
  assert.equal(accepted.adversarial.status, "passed");
  assert.equal(accepted.adversarial.verdict, "PATCH");
  const packet = JSON.parse(capAccept.out()) as {
    dispatch?: { role?: string } | null;
    adversarial_status?: string;
  };
  assert.equal(packet.dispatch?.role, "coder");
  assert.equal(packet.adversarial_status, "passed");
  assert.equal(readFileSync(paths.agentPlan, "utf8"), before);
});
