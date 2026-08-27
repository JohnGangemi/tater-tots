import assert from "node:assert/strict";
import { test } from "node:test";
import { PluginError } from "../../src/lib/errors.js";
import {
  loadPlatform,
  PLATFORM_MISSING,
} from "../../src/lib/platform-guard.js";

test("T-IN-P-03 loadPlatform mocked import fails with the short message", async () => {
  await assert.rejects(
    () =>
      loadPlatform(async () => {
        throw new Error("Cannot find package '@coredevkit/platform'");
      }),
    (err: unknown) => {
      assert.equal(err instanceof PluginError, true);
      assert.equal((err as PluginError).code, "usage");
      assert.equal((err as PluginError).message, PLATFORM_MISSING);
      return true;
    },
  );
});

test("T-IN-P-03 loadPlatform succeeds when import works", async () => {
  const mod = await loadPlatform();
  assert.equal(typeof mod.runCli, "function");
  assert.equal(typeof mod.parseArgv, "function");
  assert.equal(typeof mod.createContext, "function");
});
