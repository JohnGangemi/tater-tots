import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Finding } from "@coredevkit/platform";
import { PluginError } from "../../src/lib/errors.js";
import {
  applyEligiblePatches,
  isEligibleFinding,
  STALE_HTML_HINT,
} from "../../src/lib/gates/auto-patch.js";

const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
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

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-AR-P-05 auto_patch applies eligible patch-plan only", async () => {
  const planDir = tmp("devkit-plan-");
  const planPath = join(planDir, "plan.md");
  const original = `# Plan title

## Add coordinator library

exact-line-target

1. **S1: Add store** — paths \`src/store.ts\`.

Keep this block line
Keep this note line
`;
  writeFileSync(planPath, original);
  let err = "";
  const stderr = {
    write: (s: string) => {
      err += String(s);
      return true;
    },
  } as unknown as NodeJS.WritableStream;

  const findings: Finding[] = [
    finding({
      id: "AR-001",
      tag: "patch-plan",
      plan_target: "Add coordinator library",
      patch: "Add coordinator store\nextra leftover",
      evidence_type: "graph",
      claim: "Rename heading",
    }),
    finding({
      id: "AR-002",
      tag: "patch-plan",
      plan_target: "exact-line-target",
      patch: "exact-line-patched",
      evidence_type: "filesystem",
      claim: "Fix line",
    }),
    finding({
      id: "AR-003",
      tag: "block",
      plan_target: "Keep this block line",
      patch: "SHOULD NOT APPLY BLOCK",
      evidence_type: "filesystem",
      claim: "block finding",
    }),
    finding({
      id: "AR-004",
      tag: "note",
      plan_target: "Keep this note line",
      patch: "SHOULD NOT APPLY NOTE",
      evidence_type: "graph",
      claim: "note finding",
    }),
    finding({
      id: "AR-005",
      tag: "patch-plan",
      plan_target: "missing-path.ts",
      patch: "found-path.ts",
      evidence_type: "graph",
      claim: "No line match",
    }),
    finding({
      id: "AR-006",
      tag: "patch-plan",
      plan_target: "Add coordinator library",
      patch: "ineligible empty",
      evidence_type: "none",
      claim: "illegal pair",
    }),
    finding({
      id: "AR-007",
      tag: "patch-plan",
      plan_target: "exact-line-target",
      patch: "",
      evidence_type: "filesystem",
      claim: "empty patch",
    }),
  ];

  assert.equal(isEligibleFinding(findings[0]!), true);
  assert.equal(isEligibleFinding(findings[2]!), false);
  assert.equal(isEligibleFinding(findings[3]!), false);
  assert.equal(isEligibleFinding(findings[5]!), false);
  assert.equal(isEligibleFinding(findings[6]!), false);

  const first = await applyEligiblePatches({
    planPath,
    planDir,
    agentPlan: planPath,
    findings,
    sessionId: "sess-a",
    lastSessionId: null,
    stderr,
  });
  assert.equal(first.wrote, true);
  assert.equal(first.backedUp, true);
  assert.match(err, new RegExp(STALE_HTML_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const bak = readFileSync(join(planDir, "plan.md.bak"), "utf8");
  assert.equal(bak, original);
  const patched = readFileSync(planPath, "utf8");
  assert.match(patched, /^Add coordinator store$/m);
  assert.match(patched, /^exact-line-patched$/m);
  assert.match(patched, /Keep this block line/);
  assert.match(patched, /Keep this note line/);
  assert.doesNotMatch(patched, /SHOULD NOT APPLY/);
  assert.match(patched, /## Adversarial patches/);
  assert.match(patched, /id: AR-001/);
  assert.match(patched, /extra leftover/);
  assert.match(patched, /id: AR-005/);
  assert.match(patched, /found-path.ts/);
  assert.doesNotMatch(patched, /ineligible empty/);

  const second = await applyEligiblePatches({
    planPath,
    planDir,
    agentPlan: planPath,
    findings: [
      finding({
        id: "AR-008",
        tag: "patch-plan",
        plan_target: "exact-line-patched",
        patch: "exact-line-again",
        evidence_type: "filesystem",
      }),
    ],
    sessionId: "sess-a",
    lastSessionId: "sess-a",
    stderr,
  });
  assert.equal(second.wrote, true);
  assert.equal(second.backedUp, false);
  assert.equal(readFileSync(join(planDir, "plan.md.bak"), "utf8"), original);
  assert.match(readFileSync(planPath, "utf8"), /exact-line-again/);
});

test("append extras under an existing Adversarial patches heading", async () => {
  const planDir = tmp("devkit-plan-section-");
  const planPath = join(planDir, "plan.md");
  writeFileSync(
    planPath,
    `# Plan

## Adversarial patches

id: AR-OLD
claim: old
patch:
old.ts

## Steps

1. **S1: Keep** — paths \`src/a.ts\`.
`,
  );
  await applyEligiblePatches({
    planPath,
    planDir,
    agentPlan: planPath,
    findings: [
      finding({
        id: "AR-NEW",
        tag: "patch-plan",
        plan_target: "missing-path.ts",
        patch: "found-path.ts",
        evidence_type: "graph",
        claim: "No line match",
      }),
    ],
    sessionId: "s",
    lastSessionId: null,
  });
  const md = readFileSync(planPath, "utf8");
  const patchesAt = md.indexOf("## Adversarial patches");
  const newAt = md.indexOf("id: AR-NEW");
  const stepsAt = md.indexOf("## Steps");
  assert.ok(patchesAt >= 0);
  assert.ok(newAt > patchesAt);
  assert.ok(stepsAt > newAt);
  assert.match(md, /found-path.ts/);
  assert.match(md, /1\. \*\*S1: Keep\*\*/);
});

test("T-AR-P-05 jail requires plan.md under plan dir and equal agent_plan", async () => {
  const planDir = tmp("devkit-plan-jail-");
  const other = tmp("devkit-other-");
  const inside = join(planDir, "plan.md");
  const outside = join(other, "plan.md");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(inside, "# in\n");
  writeFileSync(outside, "# out\n");
  await assert.rejects(
    () =>
      applyEligiblePatches({
        planPath: outside,
        planDir,
        agentPlan: inside,
        findings: [
          finding({
            tag: "patch-plan",
            plan_target: "# out",
            patch: "x",
            evidence_type: "filesystem",
          }),
        ],
        sessionId: "s",
        lastSessionId: null,
      }),
    (err: unknown) => {
      assert.equal(err instanceof PluginError, true);
      assert.match((err as PluginError).message, /plan directory/);
      assert.match((err as PluginError).message, /agent_plan/);
      return true;
    },
  );
});
