import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, delimiter, join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli, type CliIo } from "../../src/cli.js";
import { createContext } from "../../src/lib/context.js";
import { cbmCli } from "../../src/lib/graph/cbm-client.js";
import { CBM_RELEASE_BASE, cbmBinaryName } from "../../src/lib/graph/cbm-release.js";
import { graphSearch } from "../../src/lib/graph/tools.js";

const dirs: string[] = [];
const fakeCbmDir = fileURLToPath(new URL("../fixtures/fake-cbm", import.meta.url));
const fakeCbmBin = join(fakeCbmDir, "codebase-memory-mcp");
chmodSync(fakeCbmBin, 0o755);

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
  const dir = tmp("devkit-init-repo-");
  git(dir, ["init"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"]);
  return dir;
}

function basePath(): string {
  return [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
}

function isolatedEnv(dataRoot: string, extra: { withFakeCbm?: boolean } = {}): NodeJS.ProcessEnv {
  const home = tmp("devkit-home-");
  const pathParts = extra.withFakeCbm ? [fakeCbmDir, basePath()] : [basePath()];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVKIT_DATA_DIR: dataRoot,
    XDG_CONFIG_HOME: tmp("devkit-xdg-"),
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, ".codex"),
    PATH: pathParts.join(delimiter),
    FAKE_CBM_STATE: join(tmp("fake-cbm-state-"), "state.json"),
  };
  delete env.DEVKIT_CBM_BINARY;
  return env;
}

function collectIo(opts: {
  stdin?: string;
  tty?: boolean;
  httpsGet?: CliIo["httpsGet"];
  out?: string[];
  err?: string[];
}): CliIo {
  return {
    stdout: {
      write: (s: string) => {
        opts.out?.push(String(s));
        return true;
      },
    } as unknown as NodeJS.WritableStream,
    stderr: {
      write: (s: string) => {
        opts.err?.push(String(s));
        return true;
      },
    } as unknown as NodeJS.WritableStream,
    ...(opts.stdin !== undefined ? { stdin: Readable.from([opts.stdin]) } : {}),
    stdinIsTTY: opts.tty === true,
    ...(opts.httpsGet ? { httpsGet: opts.httpsGet } : {}),
  };
}

function packFakeArchive(): { buf: Buffer; sha256: string; file: string; url: string } {
  const stage = tmp("cbm-arc-");
  const name = cbmBinaryName();
  writeFileSync(join(stage, name), readFileSync(fakeCbmBin));
  chmodSync(join(stage, name), 0o755);
  const file = "codebase-memory-mcp-darwin-arm64.tar.gz";
  const archive = join(stage, file);
  execFileSync("tar", ["-czf", archive, "-C", stage, name]);
  const buf = readFileSync(archive);
  return {
    buf,
    sha256: createHash("sha256").update(buf).digest("hex"),
    file,
    url: `${CBM_RELEASE_BASE}${file}`,
  };
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-IN-01 Fake CBM on PATH: devkit init writes cbm-project.json and exits 0", async () => {
  chmodSync(fakeCbmBin, 0o755);
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot, { withFakeCbm: true });
  const out: string[] = [];
  const code = await runCli(["node", "devkit", "--path", repo, "init"], env, collectIo({ out }));
  assert.equal(code, 0);
  const ctx = await createContext({ repoPath: repo, env });
  assert.equal(existsSync(ctx.paths.cbmProjectFile), true);
  const mapping = JSON.parse(readFileSync(ctx.paths.cbmProjectFile, "utf8")) as {
    cbm_project: string;
    last_status: string;
    nodes: number;
  };
  assert.equal(mapping.last_status, "ready");
  assert.equal(typeof mapping.cbm_project, "string");
  assert.equal(mapping.nodes, 3);
  assert.match(out.join(""), /graph: ready/);
});

test("T-IN-02 Missing CBM, stdin not a TTY: exit 3, no HTTP, playbook dir still created", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  let httpCalls = 0;
  const err: string[] = [];
  const code = await runCli(
    ["node", "devkit", "--path", repo, "init"],
    env,
    collectIo({
      tty: false,
      err,
      httpsGet: async () => {
        httpCalls += 1;
        return Buffer.from("no");
      },
    }),
  );
  assert.equal(code, 3);
  assert.equal(httpCalls, 0);
  const ctx = await createContext({ repoPath: repo, env });
  assert.equal(existsSync(ctx.paths.playbookDir), true);
  assert.equal(existsSync(ctx.paths.cbmProjectFile), false);
  assert.match(err.join(""), /No codebase-memory-mcp/);
});

test("T-IN-02b Missing CBM, TTY, user answers N: exit 3, no HTTP", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  let httpCalls = 0;
  const code = await runCli(
    ["node", "devkit", "--path", repo, "init"],
    env,
    collectIo({
      tty: true,
      stdin: "N\n",
      httpsGet: async () => {
        httpCalls += 1;
        return Buffer.from("no");
      },
    }),
  );
  assert.equal(code, 3);
  assert.equal(httpCalls, 0);
});

test(
  "T-IN-13 Fake CBM hangs if stdin stays open; list_projects and search_graph still return",
  { timeout: 5000 },
  async () => {
    chmodSync(fakeCbmBin, 0o755);
    const dataRoot = tmp("devkit-data-");
    const repo = makeRepo();
    const env = isolatedEnv(dataRoot, { withFakeCbm: true });
    const ctx = await createContext({ repoPath: repo, env });
    const listed = await cbmCli(
      ctx,
      "list_projects",
      { "include-details": true, limit: 100, offset: 0 },
      { timeoutMs: 2000 },
    );
    assert.ok(listed && typeof listed === "object");
    const searched = await cbmCli(
      ctx,
      "search_graph",
      { project: "x", format: "json", limit: 15, "name-pattern": ".*Handle.*" },
      { timeoutMs: 2000 },
    );
    assert.ok(searched && typeof searched === "object");
  },
);

test("T-IN-17 wrapped structuredContent.groups flattens to Hit[]", async () => {
  chmodSync(fakeCbmBin, 0o755);
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot, { withFakeCbm: true });
  const code = await runCli(["node", "devkit", "--path", repo, "init"], env, collectIo({}));
  assert.equal(code, 0);
  const ctx = await createContext({ repoPath: repo, env });
  const out = await graphSearch(ctx, { query: "HandleRequest" });
  assert.equal(out.hits.length, 1);
  assert.equal(out.hits[0]?.name, "HandleRequest");
  assert.equal(out.hits[0]?.path, "src/http.ts");
  assert.equal(out.hits[0]?.qn, "demo.src.http.HandleRequest");
});

test("T-IN-18 wrapped index_repository structuredContent makes init exit 0", async () => {
  chmodSync(fakeCbmBin, 0o755);
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot, { withFakeCbm: true });
  const code = await runCli(["node", "devkit", "--path", repo, "init"], env, collectIo({}));
  assert.equal(code, 0);
  const ctx = await createContext({ repoPath: repo, env });
  const mapping = JSON.parse(readFileSync(ctx.paths.cbmProjectFile, "utf8")) as {
    last_status: string;
    nodes: number;
    edges: number;
    cbm_project: string;
  };
  assert.equal(mapping.last_status, "ready");
  assert.equal(mapping.nodes, 3);
  assert.equal(mapping.edges, 2);
  assert.equal(mapping.cbm_project, basenameSafe(repo));
});

test("T-IN-19 TTY y: mock HTTPS matching sha writes 0700 binary and init continues", async () => {
  chmodSync(fakeCbmBin, 0o755);
  const packed = packFakeArchive();
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  const before = new Set(readdirSync(repo));
  let httpCalls = 0;
  const seenUrls: string[] = [];
  const { initGraph } = await import("../../src/lib/graph/init.js");
  const ctx = await createContext({ repoPath: repo, env });
  const result = await initGraph(ctx, {
    stdinIsTTY: true,
    stdin: Readable.from(["y\n"]),
    stdout: { write: () => true } as unknown as NodeJS.WritableStream,
    httpsGet: async (url: string) => {
      httpCalls += 1;
      seenUrls.push(url);
      return packed.buf;
    },
    asset: { url: packed.url, sha256: packed.sha256, file: packed.file },
  });
  assert.equal(result.graph, "ready");
  assert.equal(httpCalls, 1);
  assert.equal(seenUrls[0]?.startsWith(CBM_RELEASE_BASE), true);
  const dest = join(ctx.paths.binDir, cbmBinaryName());
  assert.equal(existsSync(dest), true);
  if (process.platform !== "win32") {
    assert.equal(statSync(dest).mode & 0o777, 0o700);
  }
  assert.equal(existsSync(join(ctx.paths.binDir, "cbm-release.json")), true);
  assert.equal(existsSync(ctx.paths.cbmProjectFile), true);
  const after = readdirSync(repo);
  for (const name of after) {
    if (!before.has(name)) {
      assert.notEqual(name, cbmBinaryName());
    }
  }
  assert.equal(existsSync(join(repo, cbmBinaryName())), false);
});

test("T-IN-20 checksum mismatch leaves no binary in bin/", async () => {
  const dataRoot = tmp("devkit-data-");
  const repo = makeRepo();
  const env = isolatedEnv(dataRoot);
  let httpCalls = 0;
  const err: string[] = [];
  const code = await runCli(
    ["node", "devkit", "--path", repo, "init"],
    env,
    collectIo({
      tty: true,
      stdin: "y\n",
      err,
      httpsGet: async () => {
        httpCalls += 1;
        return Buffer.from("not-the-pinned-archive");
      },
    }),
  );
  assert.equal(code, 3);
  assert.equal(httpCalls, 1);
  const ctx = await createContext({ repoPath: repo, env });
  assert.equal(existsSync(join(ctx.paths.binDir, cbmBinaryName())), false);
  if (existsSync(ctx.paths.binDir)) {
    for (const name of readdirSync(ctx.paths.binDir)) {
      assert.equal(name.startsWith(".tmp"), false);
      assert.notEqual(name, cbmBinaryName());
    }
  }
  assert.match(err.join(""), /checksum mismatch/i);
});

function basenameSafe(repo: string): string {
  return repo.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
}
