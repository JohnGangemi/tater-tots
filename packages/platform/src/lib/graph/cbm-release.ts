export const CBM_PIN_VERSION = "0.10.8";
export const CBM_PIN_TAG = "v0.10.8";
export const CBM_MIN_VERSION = "0.10.8";
export const CBM_RELEASE_BASE =
  "https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.10.8/";

export const CBM_MIN_VERSION_PARTS = [0, 10, 8] as const;

export type CbmPinnedAsset = {
  file: string;
  sha256: string;
  url: string;
};

const ASSETS: Record<string, { file: string; sha256: string }> = {
  "linux-x64": {
    file: "codebase-memory-mcp-linux-amd64.tar.gz",
    sha256: "e5cba4cad6ca8254a85f45041fc8a831908d7d5cb64f98fc3f8eb70a58671793",
  },
  "linux-arm64": {
    file: "codebase-memory-mcp-linux-arm64.tar.gz",
    sha256: "e2804a20f5a6fc392af361525a232703e351b7d1aacb81b88eef806eec5959fa",
  },
  "darwin-x64": {
    file: "codebase-memory-mcp-darwin-amd64.tar.gz",
    sha256: "2b193085410af3801634a522f4b17dcd6699695e015a068393c87817c1d260d4",
  },
  "darwin-arm64": {
    file: "codebase-memory-mcp-darwin-arm64.tar.gz",
    sha256: "9bd840dfb3ec7eaef4f310382057adaa5b0e904df883104d03ffcf39836afd07",
  },
  "win32-x64": {
    file: "codebase-memory-mcp-windows-amd64.zip",
    sha256: "b43ad982994c4d829670749e08d3b622a74bb20041fc0a7d02bef6113f81c34d",
  },
};

export function cbmBinaryName(osPlatform: NodeJS.Platform = process.platform): string {
  return osPlatform === "win32" ? "codebase-memory-mcp.exe" : "codebase-memory-mcp";
}

export function isCbmCommandName(command: string): boolean {
  const base = command.replace(/\\/g, "/").split("/").pop() ?? "";
  return base === "codebase-memory-mcp" || base === "codebase-memory-mcp.exe";
}

export function selectCbmAsset(
  osPlatform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): CbmPinnedAsset {
  const asset = ASSETS[`${osPlatform}-${arch}`];
  if (!asset) {
    throw new Error(`No pinned codebase-memory-mcp build for ${osPlatform}/${arch}`);
  }
  return { file: asset.file, sha256: asset.sha256, url: `${CBM_RELEASE_BASE}${asset.file}` };
}
