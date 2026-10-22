import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  cancelLogin,
  finishLogin,
  listAccounts,
  preferences,
  removeAccount,
  renameAccount,
  startLogin,
  useAccount,
  type Preferences,
} from "./shared/contracts.ts";
import { Failover } from "./server/failover.ts";
import { cacheFile, AccountService } from "./server/service.ts";
import { pathsFor, Store } from "./server/store.ts";
import { claudeVersion, UsageReader } from "./server/usage.ts";

/** `claude` on the daemon's PATH, else where the native installer puts it. */
function claudeBinary(): string {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".local", "bin")];
  for (const dir of dirs) {
    if (dir === "") continue;
    try {
      accessSync(join(dir, "claude"), constants.X_OK);
      return join(dir, "claude");
    } catch {
      // Not here.
    }
  }
  return "claude";
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
  const failover = new Failover(service, readPreferences);

  server.handle(listAccounts, ({ refresh }) => service.list({ refresh }));
  server.handle(useAccount, ({ id }) => service.use(id));
  server.handle(renameAccount, ({ id, name }) => service.rename(id, name));
  server.handle(removeAccount, ({ id }) => service.remove(id));
  server.handle(startLogin, ({ name }) => service.startLogin(name));
  server.handle(finishLogin, ({ session, code }) => service.finishLogin(session, code));
  server.handle(cancelLogin, async ({ session }) => {
    await service.cancelLogin(session);
    return {};
  });

  server.on("agent.turn_ended", (event, { paseo }) => failover.onTurnEnded(event, paseo));

  // Thresholds are checked on a timer that follows the configured interval.
  let timer: NodeJS.Timeout | null = null;
  const schedule = (prefs: Preferences) => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (!prefs.preemptive) return;
    timer = setInterval(() => {
      failover.checkThresholds().catch((error: unknown) => console.error("threshold check failed:", error));
    }, prefs.checkMinutes * 60_000);
    timer.unref();
  };
  void readPreferences().then(schedule);
  const unsubscribe = settings.subscribe((state) => {
    if (state.status === "ready") schedule(state.values);
  });

  // Keep the profile of the live login in step with token renewals even when nobody opens the
  // screen, so a long session never leaves its profile with a retired refresh token.
  const sync = setInterval(() => {
    service.store.sync().catch((error: unknown) => console.error("sync failed:", error));
  }, 5 * 60_000);
  sync.unref();
  void service.store.sync().catch((error: unknown) => console.error("sync failed:", error));

  return () => {
    if (timer !== null) clearInterval(timer);
    clearInterval(sync);
    unsubscribe();
    service.dispose();
  };
}
