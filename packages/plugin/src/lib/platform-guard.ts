import { PluginError } from "./errors.js";

export type PlatformModule = typeof import("@coredevkit/platform");

export type PlatformImporter = () => Promise<PlatformModule>;

const PLATFORM_MISSING =
  "platform is missing. Install @coredevkit/platform and run `devkit init`.";

export async function loadPlatform(
  dynamicImport: PlatformImporter = () => import("@coredevkit/platform"),
): Promise<PlatformModule> {
  try {
    return await dynamicImport();
  } catch {
    throw new PluginError("usage", PLATFORM_MISSING);
  }
}

export { PLATFORM_MISSING };
