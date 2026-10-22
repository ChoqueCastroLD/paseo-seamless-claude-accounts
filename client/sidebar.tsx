import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text } from "react-native";
import { listAccounts } from "../shared/contracts";
import { peak } from "../shared/usage";
import { useStrings } from "./i18n";
import { ACCOUNTS_QUERY, POLL_MS, SCREEN_ID } from "./screen";
import { meterColor } from "./styles";

/** The host row does not truncate, so a long label would squeeze out the icon. */
const LABEL_MAX = 16;

function shorten(name: string): string {
  return name.length > LABEL_MAX ? `${name.slice(0, LABEL_MAX - 1)}…` : name;
}

/** One row naming the account in use by profile, with the fuller of its two windows beside it. */
export function AccountsItem({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
  const list = useRpc(listAccounts);
  const text = useStrings();
  const query = useQuery({ queryKey: ACCOUNTS_QUERY, queryFn: () => list({ refresh: false }), refetchInterval: POLL_MS });
  const active = query.data?.accounts.find((account) => account.active);
  const used = peak(active?.usage ?? null);
  return (
    <SidebarRow
      icon="Users"
      label={active === undefined ? text.t("sidebar") : `Claude · ${shorten(active.id)}`}
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
      trailing={
        used === null ? undefined : (
          <Text style={{ color: meterColor(theme.colors, used), fontSize: 11, fontWeight: "600" }}>{Math.round(used)}%</Text>
        )
      }
    />
  );
}
