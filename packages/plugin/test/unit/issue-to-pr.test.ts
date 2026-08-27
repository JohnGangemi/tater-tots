import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parsePluginArgv } from "../../src/cli.js";
import {
  formatSow,
  parseIssueJson,
  parseIssueRef,
} from "../../src/lib/issue/gh-issue.js";
import { draftPhase, sowFilePath } from "../../src/lib/issue/pipeline.js";

const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parsePluginArgv stores issue-to-pr flags", () => {
  const parsed = parsePluginArgv([
    "node",
    "devkit",
    "issue-to-pr",
    "--issue",
    "12",
    "--accept-plan",
    "--publish",
  ]);
  assert.equal(parsed.pluginCommand, "issue-to-pr");
  assert.equal(parsed.issue, "12");
  assert.equal(parsed.acceptPlan, true);
  assert.equal(parsed.publish, true);
  const eq = parsePluginArgv([
    "node",
    "devkit",
    "issue-to-pr",
    "--issue=https://github.com/org/repo/issues/12",
  ]);
  assert.equal(eq.issue, "https://github.com/org/repo/issues/12");
  assert.equal(eq.acceptPlan, false);
  assert.equal(eq.publish, false);
});

test("parseIssueRef accepts number and URL", () => {
  assert.equal(parseIssueRef("12"), 12);
  assert.equal(parseIssueRef("https://github.com/org/repo/issues/12"), 12);
  assert.equal(
    parseIssueRef("https://github.com/org/repo/issues/12#comment"),
    12,
  );
  assert.throws(() => parseIssueRef("abc"), /Invalid --issue/);
  assert.throws(() => parseIssueRef("0"), /Invalid --issue/);
});

test("parseIssueJson and formatSow keep body out of YAML progress keys", () => {
  const issue = parseIssueJson(
    JSON.stringify({
      number: 12,
      title: "Add file A",
      body: "SECRET_BODY_TOKEN\nstatus: open\nstep_title: nope",
      labels: [{ name: "enhancement" }, "bug"],
      url: "https://example.test/issues/12",
      comments: [{ body: "please also test" }],
    }),
  );
  assert.equal(issue.number, 12);
  assert.deepEqual(issue.labels, ["enhancement", "bug"]);
  const sow = formatSow(issue);
  assert.match(sow, /^>/);
  assert.match(sow, /SECRET_BODY_TOKEN/);
  assert.match(sow, /please also test/);
  assert.match(sow, /Issue number: 12/);
});

test("sowFilePath is under progressDir not plan dir", () => {
  const progress = "/tmp/devkit/progress/repo";
  const plan = "/tmp/repo/tracked-plan";
  const sow = sowFilePath(progress, "abc123");
  assert.equal(sow, join(progress, "abc123.sow.md"));
  assert.equal(sow.startsWith(plan), false);
});

test("draftPhase is refine when plan.md exists", () => {
  assert.equal(draftPhase("/no/such/plan.md"), "draft_plan");
  const planMd = join(tmp("devkit-i2p-draft-"), "plan.md");
  writeFileSync(planMd, "# plan\n");
  assert.equal(draftPhase(planMd), "refine");
});
