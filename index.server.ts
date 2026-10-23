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
import { claudeVersion, IdentityReader, UsageReader } from "./server/usage.ts";

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
  const version = claudeVersion(binary);
  const identities = new IdentityReader({ version });
  const service = new AccountService({
    store: new Store(pathsFor(home, process.env), { whoIs: (token) => identities.whoIs(token) }),
    usage: new UsageReader({ cacheFile: cacheFile(home), version }),
    binary,
  });

  const settings = server.registerSettings(preferences);
  const defaults = preferences.schema.parse({});
  const readPreferences = async (): Promise<Preferences> => {
    const state = await settings.read();
    return state.status === "ready" ? state.values : defaults;
  };
  type Paseo = PluginHandlerContext["paseo"];

  // Every page of a daemon listing.
  const everyPage = async <T>(
    fetch: (page: { limit: number; cursor?: string }) => Promise<{
      entries: T[];
      pageInfo: { hasMore: boolean; nextCursor?: string | null };
    }>,
  ): Promise<T[]> => {
    const all: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await fetch({ limit: 200, ...(cursor ? { cursor } : {}) });
      all.push(...page.entries);
      cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
      // A cursor seen before would loop forever; stop with what has been read.
      if (cursor !== undefined && seen.has(cursor)) break;
      if (cursor !== undefined) seen.add(cursor);
    } while (cursor !== undefined);
    return all;
  };
  const listWorkspaces = (paseo: Paseo) =>
    everyPage((page) => paseo.workspaces.list({ includeBackground: true, page }));
  // Foreground agents for adoption; with `archived`, every agent, for pruning the records.
  const listAgents = async (paseo: Paseo, archived: boolean) =>
    (
      await everyPage((page) =>
        paseo.agents.list(archived ? { includeBackground: true, filter: { includeArchived: true }, page } : { page }),
      )
    ).map(({ agent }) => agent);

  const projectOf = new Map<string, string>();
  const unknownSince = new Map<string, number>();
  const resolveProject = async (workspaceId: string | null, paseo: Paseo): Promise<string | null> => {
    if (workspaceId === null) return null;
    const known = projectOf.get(workspaceId) ?? (await service.rules.read()).projectOf[workspaceId];
    if (known !== undefined) return known;
    // A workspace missing from the listing is not looked up again for a few seconds.
    if (Date.now() - (unknownSince.get(workspaceId) ?? 0) < 10_000) return null;
    for (const workspace of await listWorkspaces(paseo)) projectOf.set(workspace.id, workspace.projectId);
    for (const [id, at] of unknownSince) if (Date.now() - at >= 10_000) unknownSince.delete(id);
    if (!projectOf.has(workspaceId)) unknownSince.set(workspaceId, Date.now());
    return projectOf.get(workspaceId) ?? null;
  };
  const failover = new Failover(service, readPreferences, resolveProject);

  // Chats whose session opened without a workspace link cannot follow a switch. Reopening an idle
  // one resumes the same conversation through the session hook, which gives it its link. Each chat
  // is tried once per plugin start, and only while it is still idle right before the reopen.
  const paseoCli = paseoBinary();
  const attempts = new Map<string, number>();
  let running: Promise<void> | null = null;
  let again = false;
  let prunedAt = 0;
  const pass = async (paseo: Paseo) => {
    if (Date.now() - prunedAt > 5 * 60_000) {
      prunedAt = Date.now();
      const recorded = await service.openedAgents();
      const everyone = await listAgents(paseo, true);
      await service.forgetAgents(recorded, new Set(everyone.map((agent) => agent.id)));
    }
    const workspaces = await listWorkspaces(paseo);
    for (const workspace of workspaces) projectOf.set(workspace.id, workspace.projectId);
    await service.know([], Object.fromEntries(workspaces.map((workspace) => [workspace.id, workspace.projectId])));
    for (const id of await service.adoptable(await listAgents(paseo, false))) {
      if ((attempts.get(id) ?? 0) >= 3) continue;
      const fresh = (await paseo.agents.ref(id).refresh())?.agent ?? null;
      if (fresh === null || (await service.adoptable([fresh])).length === 0) continue;
      attempts.set(id, (attempts.get(id) ?? 0) + 1);
      if (!(await reloadAgent(paseoCli, id))) console.error(`could not reopen agent ${id} through its workspace link`);
    }
  };
  // One pass at a time; a request during a pass runs one more pass after it.
  const adopt = (paseo: Paseo): Promise<void> => {
    again = true;
    if (running !== null) return running;
    running = (async () => {
      while (again) {
        again = false;
        await pass(paseo);
      }
    })().finally(() => {
      running = null;
      if (again) void adopt(paseo);
    });
    return running;
  };
  const adoptInBackground = (paseo: Paseo) =>
    void adopt(paseo).catch((error: unknown) => console.error("adopting chats failed:", error));

  server.handle(listAccounts, async ({ refresh }, { paseo }) => {
    const [projects, workspaces] = await Promise.all([paseo.projects.list(), listWorkspaces(paseo)]);
    for (const workspace of workspaces) projectOf.set(workspace.id, workspace.projectId);
    await service.know(
      projects.projects.map((project) => project.projectId),
      Object.fromEntries(workspaces.map((workspace) => [workspace.id, workspace.projectId])),
    );
    adoptInBackground(paseo);
    const listing = await service.list({ refresh });
    const rules = await service.rules.read();
    return {
      ...listing,
      projects: projects.projects.map((project) => ({ id: project.projectId, name: project.projectDisplayName })),
      workspaces: workspaces.map((workspace) => ({
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

  server.on("agent.turn_started", (event) => service.touch(event.agent.id));
  server.on("agent.turn_ended", async (event, { paseo }) => {
    await service.touch(event.agent.id);
    await failover.onTurnEnded(event, paseo);
    adoptInBackground(paseo);
  });

  // Each workspace's chats open through a link to their account's config dir. Repointing the link
  // moves every open chat of the workspace to another account from its next turn.
  server.before("agent.session_open", async ({ request }, { paseo }) => {
    if (request.provider !== "claude") return;
    // A chat must always open: on any failure or delay it opens on the default login instead.
    const open = async () => {
      if (!service.knowsProjects) {
        const { projects } = await paseo.projects.list();
        await service.know(
          projects.map((project) => project.projectId),
          {},
        );
      }
      return service.openSession(request, await resolveProject(request.workspaceId, paseo));
    };
    let late = false;
    let timer: NodeJS.Timeout | undefined;
    // The daemon gives a before hook 30 seconds; leave room to answer within them.
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        late = true;
        resolve(undefined);
      }, 25_000);
    });
    const opening = open().then(
      async (result) => {
        // Opened after the chat went ahead without a link: forget it, so it is adopted later.
        if (late && result !== undefined) {
          await service
            .forgetAgents([request.agentId], new Set())
            .catch((error: unknown) => console.error("could not forget a chat opened too late:", error));
        }
        return result;
      },
      (error: unknown) => {
        console.error("opening a chat through its workspace link failed:", error);
        return undefined;
      },
    );
    try {
      return await Promise.race([opening, timeout]);
    } finally {
      clearTimeout(timer);
    }
  });

  let timer: NodeJS.Timeout | null = null;
  const schedule = (prefs: Preferences) => {
    service.setReturnToPriority(prefs.returnToPriority);
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
