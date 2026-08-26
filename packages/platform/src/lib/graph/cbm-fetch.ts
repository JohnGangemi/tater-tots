import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import https from "node:https";
import { join } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import type { PlatformContext } from "../context.js";
import { PlatformError } from "../errors.js";
import {
  applyUserOnlyFileSync,
  isWindows,
  mkdirUserOnlySync,
  writeFileAtomicSync,
} from "../fs-atomic.js";
import { graphUnavailable } from "./cbm-client.js";
import {
  CBM_PIN_VERSION,
  cbmBinaryName,
  selectCbmAsset,
  type CbmPinnedAsset,
} from "./cbm-release.js";

export type HttpsGet = (url: string) => Promise<Buffer>;

export type FetchCbmOpts = {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stdinIsTTY: boolean;
  httpsGet?: HttpsGet;
  asset?: CbmPinnedAsset;
};

function hostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  // Release assets redirect onto githubusercontent hosts, not only objects.
  return h === "github.com" || h.endsWith(".githubusercontent.com");
}

function sha256hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function sameDigest(a: string, b: string): boolean {
  const aa = Buffer.from(a.toLowerCase(), "hex");
  const bb = Buffer.from(b.toLowerCase(), "hex");
  if (aa.length === 0 || aa.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(aa, bb);
}

function rmQuiet(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    try {
      unlinkSync(path);
    } catch {
      // gone
    }
  }
}

function readTarStr(buf: Buffer): string {
  const z = buf.indexOf(0);
  const slice = z === -1 ? buf : buf.subarray(0, z);
  return slice.toString("utf8").trim();
}

function extractFromTar(buf: Buffer, want: string): Buffer | undefined {
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header[0] === 0) {
      break;
    }
    const name = readTarStr(header.subarray(0, 100));
    const prefix = readTarStr(header.subarray(345, 500));
    const full = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(readTarStr(header.subarray(124, 136)), 8);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    offset += 512;
    const dataSize = Number.isFinite(size) ? size : 0;
    const data = buf.subarray(offset, Math.min(offset + dataSize, buf.length));
    offset += Math.ceil(dataSize / 512) * 512;
    if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
      const base = full.split("/").filter(Boolean).pop();
      if (base === want) {
        return Buffer.from(data);
      }
    }
  }
  return undefined;
}

function extractFromZip(buf: Buffer, want: string): Buffer | undefined {
  let i = 0;
  while (i + 30 <= buf.length) {
    if (buf.readUInt32LE(i) !== 0x04034b50) {
      break;
    }
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString("utf8");
    const dataStart = i + 30 + nameLen + extraLen;
    const data = buf.subarray(dataStart, Math.min(dataStart + compSize, buf.length));
    i = dataStart + compSize;
    const base = name.split("/").filter(Boolean).pop();
    if (base !== want) {
      continue;
    }
    if (method === 0) {
      return Buffer.from(data);
    }
    if (method === 8) {
      return inflateRawSync(data);
    }
  }
  return undefined;
}

function extractBinary(archive: Buffer, file: string, want: string): Buffer {
  const lower = file.toLowerCase();
  let found: Buffer | undefined;
  if (lower.endsWith(".zip")) {
    found = extractFromZip(archive, want);
  } else {
    let unzipped: Buffer;
    try {
      unzipped = gunzipSync(archive);
    } catch {
      throw graphUnavailable("CBM archive is not gzip");
    }
    found = extractFromTar(unzipped, want);
  }
  if (!found) {
    throw graphUnavailable(`CBM archive missing ${want}`);
  }
  return found;
}

export function defaultHttpsGet(urlStr: string, redirects = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(urlStr);
    } catch {
      reject(graphUnavailable("Invalid download URL"));
      return;
    }
    if (u.protocol !== "https:") {
      reject(graphUnavailable("CBM download requires HTTPS"));
      return;
    }
    if (!hostAllowed(u.hostname)) {
      reject(graphUnavailable(`Refusing download host ${u.hostname}`));
      return;
    }
    const req = https.get(u, { timeout: 60_000 }, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 5) {
          reject(graphUnavailable("Too many redirects"));
          return;
        }
        const next = new URL(res.headers.location, u).toString();
        defaultHttpsGet(next, redirects + 1).then(resolve, reject);
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(graphUnavailable(`CBM download HTTP ${code}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => {
        chunks.push(c);
      });
      res.on("end", () => {
        resolve(Buffer.concat(chunks));
      });
      res.on("error", (e) => {
        reject(graphUnavailable("CBM download failed", String(e)));
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(graphUnavailable("CBM download timed out"));
    });
    req.on("error", (e) => {
      reject(graphUnavailable("CBM download failed", String(e)));
    });
  });
}

function readLine(stdin: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    stdin.resume();
    let acc = "";
    const onData = (c: Buffer | string) => {
      acc += String(c);
      if (acc.includes("\n") || acc.includes("\r")) {
        cleanup();
        resolve(acc.replace(/[\r\n].*$/s, ""));
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(acc);
    };
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.pause();
    };
    if ("readableEnded" in stdin && (stdin as { readableEnded?: boolean }).readableEnded) {
      resolve("");
      return;
    }
    stdin.on("data", onData);
    stdin.on("end", onEnd);
  });
}

export async function confirmPinnedFetch(
  opts: FetchCbmOpts,
  asset: CbmPinnedAsset,
  dest: string,
): Promise<boolean> {
  if (!opts.stdinIsTTY) {
    return false;
  }
  opts.stdout.write(`${asset.url}\n`);
  opts.stdout.write(`${CBM_PIN_VERSION}\n`);
  opts.stdout.write(`${asset.sha256}\n`);
  opts.stdout.write(`${dest}\n`);
  opts.stdout.write(`Download pinned codebase-memory-mcp v${CBM_PIN_VERSION} into ${dest}? [y/N] `);
  const answer = (await readLine(opts.stdin)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

function applyExecMode(file: string): void {
  if (isWindows()) {
    applyUserOnlyFileSync(file);
    return;
  }
  chmodSync(file, 0o700);
}

export async function fetchPinnedCbm(ctx: PlatformContext, opts: FetchCbmOpts): Promise<string> {
  let asset: CbmPinnedAsset;
  try {
    asset = opts.asset ?? selectCbmAsset();
  } catch (err) {
    throw graphUnavailable(err instanceof Error ? err.message : "No pinned CBM build");
  }
  const dest = join(ctx.paths.binDir, cbmBinaryName());
  mkdirUserOnlySync(ctx.paths.binDir);
  const get = opts.httpsGet ?? defaultHttpsGet;
  const archive = await get(asset.url);
  const tmpArc = join(
    ctx.paths.binDir,
    `.tmp-arc-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  const tmpBin = join(
    ctx.paths.binDir,
    `.tmp-bin-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  let destWritten = false;
  const releaseFile = join(ctx.paths.binDir, "cbm-release.json");
  try {
    writeFileSync(tmpArc, archive);
    if (!sameDigest(sha256hex(archive), asset.sha256)) {
      throw graphUnavailable("CBM archive checksum mismatch");
    }
    const binary = extractBinary(archive, asset.file, cbmBinaryName());
    writeFileSync(tmpBin, binary, { mode: 0o700 });
    applyExecMode(tmpBin);
    const st = statSync(tmpBin);
    if (!st.isFile()) {
      throw graphUnavailable("CBM extract is not a file");
    }
    if (existsSync(dest)) {
      unlinkSync(dest);
    }
    renameSync(tmpBin, dest);
    destWritten = true;
    applyExecMode(dest);
    writeFileAtomicSync(
      releaseFile,
      `${JSON.stringify(
        {
          version: CBM_PIN_VERSION,
          url: asset.url,
          sha256: asset.sha256,
          downloaded_at: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    return dest;
  } catch (err) {
    rmQuiet(tmpArc);
    rmQuiet(tmpBin);
    if (destWritten) {
      rmQuiet(dest);
      rmQuiet(releaseFile);
    }
    if (err instanceof PlatformError) {
      throw err;
    }
    throw graphUnavailable("CBM fetch failed", err instanceof Error ? err.message : String(err));
  } finally {
    rmQuiet(tmpArc);
    rmQuiet(tmpBin);
  }
}
