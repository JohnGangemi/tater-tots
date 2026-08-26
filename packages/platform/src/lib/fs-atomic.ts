import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { PlatformError } from "./errors.js";

const WINDOWS = process.platform === "win32";

export function isWindows(): boolean {
  return WINDOWS;
}

function isDirMissing(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT",
  );
}

function ioError(message: string, hint?: string): PlatformError {
  return new PlatformError("io", message, hint);
}

function applyOwnerOnlyDaclSync(target: string): void {
  const script = `
$ErrorActionPreference = 'Stop'
$p = $env:DEVKIT_ACL_PATH
if (-not (Test-Path -LiteralPath $p)) { throw "path missing: $p" }
$isDir = Test-Path -LiteralPath $p -PathType Container
$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
if ($null -eq $id.User) { throw "no current user SID" }
if ($isDir) {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
} else {
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $inherit = [System.Security.AccessControl.InheritanceFlags]::None
}
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($id.User)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
  $id.User,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inherit,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
[void]$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $p -AclObject $acl
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...process.env, DEVKIT_ACL_PATH: target },
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || "DACL command failed";
    throw ioError("Could not set owner-only DACL", detail);
  }
}

export function applyUserOnlyDirSync(dir: string): void {
  if (WINDOWS) {
    applyOwnerOnlyDaclSync(dir);
    return;
  }
  chmodSync(dir, 0o700);
}

export function applyUserOnlyFileSync(file: string): void {
  if (WINDOWS) {
    applyOwnerOnlyDaclSync(file);
    return;
  }
  chmodSync(file, 0o600);
}

export function mkdirUserOnlySync(dir: string): void {
  const resolved = resolve(dir);
  const created: string[] = [];
  let cur = resolved;
  while (!existsSync(cur)) {
    created.push(cur);
    const parent = dirname(cur);
    if (parent === cur) {
      break;
    }
    cur = parent;
  }
  try {
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw ioError(`Could not create directory ${resolved}`, String(err));
  }
  try {
    for (const d of created) {
      applyUserOnlyDirSync(d);
    }
    applyUserOnlyDirSync(resolved);
  } catch (err) {
    if (err instanceof PlatformError) {
      throw err;
    }
    throw ioError(`Could not set directory permissions on ${resolved}`, String(err));
  }
}

export function writeFileAtomicSync(file: string, data: string | Buffer): void {
  const resolved = resolve(file);
  mkdirUserOnlySync(dirname(resolved));
  const tmp = `${resolved}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "w", 0o600);
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    writeSync(fd, buf);
    if (!WINDOWS) {
      fsyncSync(fd);
    }
    closeSync(fd);
    fd = undefined;
    applyUserOnlyFileSync(tmp);
    renameSync(tmp, resolved);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close after a failed write
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // tmp may not exist
    }
    if (err instanceof PlatformError) {
      throw err;
    }
    throw ioError(`Could not write ${resolved}`, String(err));
  }
  try {
    applyUserOnlyFileSync(resolved);
  } catch (err) {
    try {
      unlinkSync(resolved);
    } catch {
      // dest may already be gone
    }
    if (err instanceof PlatformError) {
      throw err;
    }
    throw ioError(`Could not set file permissions on ${resolved}`, String(err));
  }
}

export function movePathSync(from: string, to: string, kind: "file" | "dir"): void {
  mkdirUserOnlySync(dirname(to));
  try {
    renameSync(from, to);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : "";
    if (code === "EXDEV") {
      if (kind === "file") {
        copyFileSync(from, to);
        unlinkSync(from);
      } else {
        throw ioError(`Could not move directory across devices: ${to}`);
      }
    } else if (isDirMissing(err)) {
      return;
    } else {
      throw ioError(`Could not move ${from} to ${to}`, String(err));
    }
  }
  if (kind === "file") {
    applyUserOnlyFileSync(to);
  } else {
    applyUserOnlyDirSync(to);
  }
}

export async function mkdirUserOnly(dir: string): Promise<void> {
  mkdirUserOnlySync(dir);
}

export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  writeFileAtomicSync(file, data);
}
