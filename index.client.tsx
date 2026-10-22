import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { AccountsScreen } from "./client/screen";
import { listAccounts, useAccount } from "./shared/accounts";

/** Sidebar entry, so the switch is one click and not a command to remember. */
function AccountsItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow icon="Users" active={currentScreen?.screenId === "accounts"} onPress={() => openScreen({ screenId: "accounts" })} />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "accounts", title: "Cuentas Claude", Component: AccountsScreen });
  client.addSidebarHeaderItem({ id: "accounts", title: "Cuentas Claude", Component: AccountsItem });
  client.addCommandCenterItem({
    id: "open-accounts",
    title: "Cambiar de cuenta Claude",
    icon: "Users",
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "accounts" });
    },
  });
  client.addSlashCommand({
    name: "cuenta",
    description: "Cambia la cuenta Claude activa",
    argumentHint: "[nombre]",
    context: "agent",
    async onSubmit({ args, rpc }) {
      const name = args.trim();
      const { accounts } = await rpc(listAccounts, {});
      if (name === "") {
        const active = accounts.find((account) => account.active);
        throw new Error(`Cuenta activa: ${active?.email ?? "desconocida"}. Usa /cuenta <nombre>.`);
      }
      const match = accounts.find((account) => account.id === name || account.email.startsWith(name));
      if (match === undefined) throw new Error(`No encontré la cuenta "${name}".`);
      const result = await rpc(useAccount, { id: match.id });
      if (!result.ok) throw new Error(result.error);
    },
  });
  return () => {};
}
