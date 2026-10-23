import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext, PluginCommandCapabilities, PluginScreenProps } from "@getpaseo/plugin/client";
import { AccountsScreen, SCREEN_ID, SETTINGS_ID } from "./client/screen";
import { SettingsScreen } from "./client/settings";
import { AccountsItem } from "./client/sidebar";
import { SwitchNotice } from "./client/timeline-row";
import { contributeWorkspaceButtons } from "./client/workspace-accounts";
import { deviceLanguage, strings, type Strings } from "./client/i18n";
import { listAccounts, preferences, switchAccount, switchRow, type Account } from "./shared/contracts";

const COMMANDS_REFRESH_MS = 5 * 60_000;

type Rpc = PluginCommandCapabilities["rpc"];

async function callbackStrings(rpc: Rpc): Promise<Strings> {
  const state = await rpc(settingsRpc(preferences.id).read, {}).catch(() => null);
  const parsed = state?.status === "ready" ? preferences.schema.safeParse(state.values) : null;
  const language = parsed?.success ? parsed.data.language : "auto";
  return strings(language === "auto" ? deviceLanguage() : language);
}

function match(accounts: Account[], query: string): Account | undefined {
  const needle = query.trim().toLowerCase();
  return (
    accounts.find((account) => account.id === needle || account.email.toLowerCase() === needle) ??
    accounts.find((account) => account.id.startsWith(needle) || account.email.toLowerCase().startsWith(needle))
  );
}

async function switchTo(rpc: Rpc, query: string): Promise<void> {
  const text = await callbackStrings(rpc);
  const { accounts } = await rpc(listAccounts, { refresh: false });
  if (query.trim() === "") {
    const active = accounts.find((account) => account.active);
    throw new Error(text.t("slashActive", { email: active?.email || active?.id || "–" }));
  }
  const target = match(accounts, query);
  if (target === undefined) throw new Error(text.t("slashUnknown", { name: query.trim() }));
  const result = await rpc(switchAccount, { id: target.id });
  if (!result.ok) throw new Error(text.error(result.error, result.detail));
}

export default function contribute(client: PluginClientContext) {
  const text = strings(deviceLanguage());
  const Screen = (props: PluginScreenProps) => (
    <AccountsScreen {...props} openSettings={(id) => client.openSettings(id)} />
  );

  client.addScreen({ id: SCREEN_ID, title: text.t("title"), Component: Screen });
  client.addSettingsScreen({
    id: SETTINGS_ID,
    title: text.t("settingsTitle"),
    icon: "Users",
    Component: SettingsScreen,
  });
  client.addSidebarHeaderItem({ id: SCREEN_ID, title: text.t("sidebar"), Component: AccountsItem });
  client.addTimelineRenderer({ ...switchRow, Component: SwitchNotice });

  client.addCommandCenterItem({
    id: "open-accounts",
    title: text.t("commandOpen"),
    icon: "Users",
    context: "global",
    onSelect: ({ openScreen }) => openScreen({ screenId: SCREEN_ID }),
  });
  client.addCommandCenterItem({
    id: "open-settings",
    title: text.t("commandSettings"),
    icon: "Settings",
    context: "global",
    onSelect: ({ openSettings }) => openSettings(SETTINGS_ID),
  });

  for (const name of ["account", "cuenta"]) {
    client.addSlashCommand({
      name,
      description: text.t("slashDescription"),
      argumentHint: text.t("slashHint"),
      context: "workspace",
      onSubmit: ({ args, rpc }) => switchTo(rpc, args),
    });
  }

  let removers: Array<() => void> = [];
  const registerAccounts = async () => {
    const { accounts } = await client.rpc(listAccounts, { refresh: false });
    for (const remove of removers) remove();
    removers = accounts
      .filter((account) => account.status === "ready")
      .map((account) =>
        client.addCommandCenterItem({
          id: `use-${account.id}`,
          title: `${text.t("use")}: ${account.email || account.id}`,
          icon: "UserCheck",
          context: "global",
          onSelect: async ({ rpc }) => {
            await switchTo(rpc, account.id);
            await registerAccounts();
          },
        }),
      );
  };
  const refresh = () =>
    void registerAccounts().catch((error: unknown) => console.warn("[seamless-claude-accounts]", error));
  refresh();
  const timer = setInterval(refresh, COMMANDS_REFRESH_MS);

  const stopButtons = contributeWorkspaceButtons(client, text.t("workspaceButton"));

  return () => {
    stopButtons();
    clearInterval(timer);
    for (const remove of removers) remove();
  };
}
