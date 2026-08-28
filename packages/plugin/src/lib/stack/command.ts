import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PlatformContext } from "@coredevkit/platform";
import { withProgressLock } from "../coordinator/store.js";
import { PluginError } from "../errors.js";
import { graphStateFromMapping } from "../plan/graph-state.js";
import { htmlHint, type RunPacket } from "../plan/packet.js";
import type { PlatformModule } from "../platform-guard.js";
import { loadPluginConfig } from "../plugin-config.js";
import { worktreeHash } from "../worktree.js";
import { publishStack } from "./create.js";

export type StackCliIo = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

export type StackArgv = {
  remaining: string[];
  plan?: string;
  rest: string[];
};

function overrideLoaded(ctx: PlatformContext, skill: string): boolean {
  return existsSync(join(ctx.paths.overridesDir, `${skill}.override.md`));
}

export async function runStackCommand(
  platform: PlatformModule,
  argv: StackArgv,
  env: NodeJS.ProcessEnv,
  io: StackCliIo,
): Promise<number> {
  if (argv.rest[0] !== "publish") {
    throw new PluginError("usage", "usage: devkit stack publish");
  }
  const args = platform.parseArgv(argv.remaining);
  const ctx = await platform.createContext({
    repoPath: args.path,
    configFile: args.config,
    verification: args.verification,
    env,
  });
  const cfg = loadPluginConfig(ctx, {
    configFile: args.config,
    ...(argv.plan !== undefined ? { planDir: argv.plan } : {}),
  });

  return withProgressLock(
    ctx,
    { plugin: cfg, configFile: args.config },
    async (api) => {
      const got = api.tryRead();
      if (got.corrupt) {
        throw new PluginError("usage", "coordinator file is corrupt");
      }
      if (!got.record) {
        throw new PluginError(
          "not_found",
          "coordinator file not found",
          "run devkit plan --start-coordinator",
        );
      }
      const out = await publishStack({
        ctx,
        record: got.record,
        write: (next) => api.write(next),
        io,
      });
      const record = out.record;
      const wt = worktreeHash(ctx.repoPath);
      const item = out.item;
      const packet: RunPacket = {
        command: "stack",
        repo_id: ctx.repoId,
        worktree_hash: wt.worktree_hash,
        resolved_level: ctx.config.resolved_level,
        graph: graphStateFromMapping(ctx),
        plan_dir: record.plan_dir,
        html_path: record.html_path,
        agent_plan: record.agent_plan,
        resume_step_id: record.resume_step_id,
        stack_phase: item?.phase ?? null,
        stack_branch: item?.branch ?? null,
        adversarial_status: record.adversarial.status,
        dispatch: null,
        packet: null,
        skill: "implement",
        override_loaded: overrideLoaded(ctx, "implement"),
        hint: out.hint || htmlHint(record.html_path),
      };
      io.stdout.write(`${JSON.stringify(packet)}\n`);
      io.stderr.write(`${packet.hint}\n`);
      return 0;
    },
  );
}
