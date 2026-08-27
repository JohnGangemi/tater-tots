import { homedir } from "node:os";
import { basename, join } from "node:path";

export type EnvMap = NodeJS.ProcessEnv;

export type DevkitPaths = {
  dataRoot: string;
  devkitHome: string;
  configHome: string;
  userConfigFile: string;
  playbookDir: string;
  playbookFile: string;
  playbookBakFile: string;
  identityFile: string;
  overridesDir: string;
  proposalsDir: string;
  signalsFile: string;
  graphDir: string;
  cbmProjectFile: string;
  binDir: string;
  logsDir: string;
  platformLogFile: string;
  hooksLogFile: string;
  sessionPointerFile: string;
  statsFile: string;
};

function stripTrailingSep(p: string): string {
  return p.replace(/[\\/]+$/g, "");
}

function usesXdgConfig(osPlatform: NodeJS.Platform): boolean {
  return osPlatform !== "darwin" && osPlatform !== "win32";
}

/** Join DATA_ROOT + devkit once. Do not create .../devkit/devkit. */
export function joinDevkitHome(dataRoot: string): string {
  const norm = stripTrailingSep(dataRoot);
  if (basename(norm).toLowerCase() === "devkit") {
    return norm;
  }
  return join(norm, "devkit");
}

export function resolveDataRoot(
  env: EnvMap = process.env,
  osPlatform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const override = env.DEVKIT_DATA_DIR?.trim();
  if (override) {
    return stripTrailingSep(override);
  }
  if (osPlatform === "darwin") {
    return join(home, "Library", "Application Support");
  }
  if (osPlatform === "win32") {
    const appdata = env.APPDATA?.trim();
    if (appdata) {
      return stripTrailingSep(appdata);
    }
    return join(home, "AppData", "Roaming");
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) {
    return stripTrailingSep(xdg);
  }
  return join(home, ".local", "share");
}

export function resolveDevkitHome(
  env: EnvMap = process.env,
  osPlatform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  return joinDevkitHome(resolveDataRoot(env, osPlatform, home));
}

export function resolveConfigHome(
  env: EnvMap = process.env,
  osPlatform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  dataRoot?: string,
): string {
  if (usesXdgConfig(osPlatform)) {
    const xdg = env.XDG_CONFIG_HOME?.trim();
    const base = xdg ? stripTrailingSep(xdg) : join(home, ".config");
    return join(base, "devkit");
  }
  const root = dataRoot ?? resolveDataRoot(env, osPlatform, home);
  return joinDevkitHome(root);
}

export function userDataPaths(
  dataRoot: string,
  repoId: string,
  env: EnvMap = process.env,
  osPlatform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): DevkitPaths {
  const devkitHome = joinDevkitHome(dataRoot);
  const configHome = resolveConfigHome(env, osPlatform, home, dataRoot);
  const playbookDir = join(devkitHome, "playbooks", repoId);
  const overridesDir = join(devkitHome, "overrides", repoId);
  const graphDir = join(devkitHome, "graph", repoId);
  const logsDir = join(devkitHome, "logs");
  return {
    dataRoot,
    devkitHome,
    configHome,
    userConfigFile: join(configHome, "config.yaml"),
    playbookDir,
    playbookFile: join(playbookDir, "playbook.zst"),
    playbookBakFile: join(playbookDir, "playbook.zst.bak"),
    identityFile: join(playbookDir, "identity.json"),
    overridesDir,
    proposalsDir: join(overridesDir, "proposals"),
    signalsFile: join(overridesDir, "signals.jsonl"),
    graphDir,
    cbmProjectFile: join(graphDir, "cbm-project.json"),
    binDir: join(devkitHome, "bin"),
    logsDir,
    platformLogFile: join(logsDir, "platform.jsonl"),
    hooksLogFile: join(logsDir, "hooks.jsonl"),
    sessionPointerFile: join(logsDir, "session-pointer.json"),
    statsFile: join(devkitHome, "stats.json"),
  };
}
