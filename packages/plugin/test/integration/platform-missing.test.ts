import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PLATFORM_MISSING } from "../../src/lib/platform-guard.js";

const dirs: string[] = [];
const pluginRoot = fileURLToPath(new URL("../..", import.meta.url));

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

test("T-IN-P-03 built CLI without platform prints one line and exits 1", () => {
  const prefix = tmp("devkit-missing-plat-");
  const distSrc = join(pluginRoot, "dist");
  const distDest = join(prefix, "dist");
  cpSync(distSrc, distDest, { recursive: true });
  const cli = join(distDest, "cli.js");
  const home = tmp("devkit-home-");
  const env: NodeJS.ProcessEnv = {
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: home,
    USERPROFILE: home,
    DEVKIT_DATA_DIR: tmp("devkit-data-"),
    XDG_CONFIG_HOME: tmp("devkit-xdg-"),
  };
  const r = spawnSync(process.execPath, [cli, "plan"], {
    cwd: prefix,
    env,
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, `devkit: ${PLATFORM_MISSING}\n`);
  assert.equal(r.stdout, "");
});
