import { randomBytes } from "node:crypto";
import { renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  applyUserOnlyDirSync,
  applyUserOnlyFileSync,
  mkdirUserOnly,
  writeFileAtomic,
} from "@coredevkit/platform";

export {
  applyUserOnlyDirSync,
  applyUserOnlyFileSync,
  mkdirUserOnly,
  writeFileAtomic,
};

/** Write dest via progressDir/.tmp then rename so leftover temps are not progress files. */
export async function writeProgressAtomic(
  destFile: string,
  data: string,
  tmpDir: string,
): Promise<void> {
  await mkdirUserOnly(dirname(destFile));
  await mkdirUserOnly(tmpDir);
  applyUserOnlyDirSync(tmpDir);
  const tmpFile = join(
    tmpDir,
    `${basename(destFile)}.${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  await writeFileAtomic(tmpFile, data);
  renameSync(tmpFile, destFile);
  applyUserOnlyFileSync(destFile);
}
