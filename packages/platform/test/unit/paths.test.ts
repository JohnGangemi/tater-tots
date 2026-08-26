import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { mkdirUserOnlySync, writeFileAtomicSync, isWindows } from "../../src/lib/fs-atomic.js";
import {
  joinDevkitHome,
  resolveConfigHome,
  resolveDataRoot,
  resolveDevkitHome,
  userDataPaths,
} from "../../src/lib/paths.js";
import { createContext } from "../../src/lib/context.js";
import { execFileSync } from "node:child_process";

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

test("DATA_ROOT and DEVKIT_HOME do not nest devkit/devkit", () => {
  assert.equal(joinDevkitHome("/tmp/data"), join("/tmp/data", "devkit"));
  assert.equal(joinDevkitHome("/tmp/data/devkit"), "/tmp/data/devkit");
  const env = { DEVKIT_DATA_DIR: "/tmp/ci-data" };
  assert.equal(resolveDataRoot(env, "linux", "/home/u"), "/tmp/ci-data");
  assert.equal(resolveDevkitHome(env, "linux", "/home/u"), join("/tmp/ci-data", "devkit"));
  const already = { DEVKIT_DATA_DIR: "/tmp/ci-data/devkit" };
  assert.equal(resolveDevkitHome(already, "linux", "/home/u"), "/tmp/ci-data/devkit");
});

test("Linux config uses XDG; macOS and Windows use DEVKIT_HOME", () => {
  const linux = resolveConfigHome(
    { XDG_CONFIG_HOME: "/home/u/.config" },
    "linux",
    "/home/u",
    "/home/u/.local/share",
  );
  assert.equal(linux, join("/home/u/.config", "devkit"));
  const mac = resolveConfigHome({}, "darwin", "/Users/u", "/Users/u/Library/Application Support");
  assert.equal(mac, join("/Users/u/Library/Application Support", "devkit"));
  const win = resolveConfigHome(
    { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
    "win32",
    "C:\\Users\\u",
    "C:\\Users\\u\\AppData\\Roaming",
  );
  assert.equal(win, join("C:\\Users\\u\\AppData\\Roaming", "devkit"));
});

test("userDataPaths puts the playbook under DEVKIT_HOME/playbooks/<repo-id>", () => {
  const dataRoot = "/tmp/udata";
  const paths = userDataPaths(dataRoot, "abc123", {}, "darwin", "/Users/u");
  assert.equal(paths.devkitHome, join("/tmp/udata", "devkit"));
  assert.equal(
    paths.playbookFile,
    join("/tmp/udata", "devkit", "playbooks", "abc123", "playbook.zst"),
  );
  assert.equal(
    paths.identityFile,
    join("/tmp/udata", "devkit", "playbooks", "abc123", "identity.json"),
  );
});

test("T-FS-01 New playbook dir mode 0700, file 0600 on POSIX", async () => {
  const dataRoot = tmp("devkit-data-");
  const playDir = join(dataRoot, "devkit", "playbooks", "repoid");
  mkdirUserOnlySync(playDir);
  const file = join(playDir, "playbook.zst");
  writeFileAtomicSync(file, "x");
  if (isWindows()) {
    return;
  }
  const dirMode = statSync(playDir).mode & 0o777;
  const fileMode = statSync(file).mode & 0o777;
  assert.equal(dirMode, 0o700);
  assert.equal(fileMode, 0o600);

  const repo = tmp("devkit-fs-repo-");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init"], {
    cwd: repo,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"],
    {
      cwd: repo,
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
    },
  );
  const ctx = await createContext({
    repoPath: repo,
    env: { ...process.env, DEVKIT_DATA_DIR: dataRoot },
  });
  const ctxDirMode = statSync(ctx.paths.playbookDir).mode & 0o777;
  const identMode = statSync(ctx.paths.identityFile).mode & 0o777;
  assert.equal(ctxDirMode, 0o700);
  assert.equal(identMode, 0o600);
});
