import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  cancelLogin,
  finishLogin,
  assignProjects,
  assignWorkspace,
  listAccounts,
  preferences,
  removeAccount,
  renameAccount,
  reorderAccounts,
  startLogin,
  switchAccount,
  type Preferences,
} from "./shared/contracts.ts";
import { Failover } from "./server/failover.ts";
import { cacheFile, AccountService } from "./server/service.ts";
import { pathsFor, Store } from "./server/store.ts";
import { claudeVersion, UsageReader } from "./server/usage.ts";

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function claudeBinary(): string {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".local", "bin")];
  return (
    dirs
      .filter((dir) => dir !== "")
      .map((dir) => join(dir, "claude"))
      .find(isExecutable) ?? "claude"
  );
}

/** The paseo CLI beside the daemon's node, else on PATH. */
function paseoBinary(): string {
  const beside = join(dirname(process.execPath), "paseo");
  return isExecutable(beside) ? beside : "paseo";
}

function reloadAgent(binary: string, agentId: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(binary, ["agent", "reload", agentId], { timeout: 5 * 60_000 }, (error) => resolve(error === null));
  });
}

export default function contribute(server: PluginServerContext) {
  const home = homedir();
  const binary = process.env.SEAMLESS_CLAUDE_BINARY ?? claudeBinary();
  const service = new AccountService({
    store: new Store(pathsFor(home, process.env)),
    usage: new UsageReader({ cacheFile: cacheFile(home), version: claudeVersion(binary) }),
    binary,
  });

  const settings = server.registerSettings(preferences);
  const defaults = preferences.schema.parse({});
  const readPreferences = async (): Promise<Preferences> => {
    const state = await settings.read();
    return state.status === "ready" ? state.values : defaults;
  };
  type Paseo = PluginHandlerContext["paseo"];
  const projectOf = new Map<string, string>();
  const resolveProject = async (workspaceId: string | null, paseo: Paseo): Promise<string | null> => {
    if (workspaceId === null) return null;
    if (!projectOf.has(workspaceId)) {
      const { entries } = await paseo.workspaces.list();
      for (const workspace of entries) projectOf.set(workspace.id, workspace.projectId);
    }
    return projectOf.get(workspaceId) ?? null;
  };
  const failover = new Failover(service, readPreferences, resolveProject);

  // Chats whose session opened without a workspace link cannot follow a switch. Reopening an idle
  // one resumes the same conversation through the session hook, which gives it its link.
  const paseoCli = paseoBinary();
  const adopting = new Set<string>();
  const adopt = async (paseo: Paseo) => {
    const { entries } = await paseo.agents.list();
    await service.forgetAgentsExcept(new Set(entries.map(({ agent }) => agent.id)));
    for (const id of await service.adoptable(entries.map(({ agent }) => agent))) {
      if (adopting.has(id)) continue;
      adopting.add(id);
      const ok = await reloadAgent(paseoCli, id);
      if (!ok) console.error(`could not reopen agent ${id} through its workspace link`);
      adopting.delete(id);
    }
  };
  const adoptInBackground = (paseo: Paseo) =>
    void adopt(paseo).catch((error: unknown) => console.error("adopting chats failed:", error));

  server.handle(listAccounts, async ({ refresh }, { paseo }) => {
    const [projects, workspaces] = await Promise.all([paseo.projects.list(), paseo.workspaces.list()]);
    for (const workspace of workspaces.entries) projectOf.set(workspace.id, workspace.projectId);
    await service.know(
      projects.projects.map((project) => project.projectId),
      Object.fromEntries(workspaces.entries.map((workspace) => [workspace.id, workspace.projectId])),
    );
    adoptInBackground(paseo);
    const listing = await service.list({ refresh });
    const rules = await service.rules.read();
    return {
      ...listing,
      projects: projects.projects.map((project) => ({ id: project.projectId, name: project.projectDisplayName })),
      workspaces: workspaces.entries.map((workspace) => ({
        id: workspace.id,
        name: workspace.title ?? workspace.name,
        projectId: workspace.projectId,
      })),
      choices: rules.workspaces,
      excluded: rules.excluded,
    };
  });
  server.handle(switchAccount, ({ id }) => service.use(id));
  server.handle(reorderAccounts, async ({ ids }) => {
    await service.reorder(ids);
    return {};
  });
  server.handle(assignProjects, ({ id, projects, known, everywhere }) =>
    service.assignProjects(id, projects, { everywhere, known }),
  );
  server.handle(assignWorkspace, ({ workspaceId, accounts }) => service.assignWorkspace(workspaceId, accounts));
  server.handle(renameAccount, ({ id, name }) => service.rename(id, name));
  server.handle(removeAccount, ({ id }) => service.remove(id));
  server.handle(startLogin, ({ name }) => service.startLogin(name));
  server.handle(finishLogin, ({ session, code }) => service.finishLogin(session, code));
  server.handle(cancelLogin, async ({ session }) => {
    await service.cancelLogin(session);
    return {};
  });

  server.on("agent.turn_ended", async (event, { paseo }) => {
    await failover.onTurnEnded(event, paseo);
    adoptInBackground(paseo);
  });

  // Each project's chats open through a link to their account's config dir. Repointing the link
  // moves every open chat of the project to another account on its next request.
  server.before("agent.session_open", async ({ request }, { paseo }) => {
    if (request.provider !== "claude") return;
    if (!service.knowsProjects) {
      const { projects } = await paseo.projects.list();
      await service.know(
        projects.map((project) => project.projectId),
        {},
      );
    }
    return service.openSession(request, await resolveProject(request.workspaceId, paseo));
  });

  let timer: NodeJS.Timeout | null = null;
  const schedule = (prefs: Preferences) => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (!prefs.preemptive && !prefs.returnToPriority) return;
    timer = setInterval(() => {
      failover.rebalance().catch((error: unknown) => console.error("rebalance failed:", error));
    }, prefs.checkMinutes * 60_000);
    timer.unref();
  };
  void readPreferences().then(schedule);
  const unsubscribe = settings.subscribe((state) => {
    if (state.status === "ready") schedule(state.values);
  });

  // Claude Code rotates refresh tokens in the live files only; keep the owning profiles current.
  const sync = () => void service.list().catch((error: unknown) => console.error("sync failed:", error));
  const syncTimer = setInterval(sync, 5 * 60_000);
  syncTimer.unref();
  sync();

  return () => {
    if (timer !== null) clearInterval(timer);
    clearInterval(syncTimer);
    unsubscribe();
    service.dispose();
  };
}
