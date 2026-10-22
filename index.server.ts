import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listAccounts, useAccount } from "./server/accounts.ts";
import { listAccounts as listAccountsRpc, useAccount as useAccountRpc } from "./shared/accounts.ts";

export default function contribute(server: PluginServerContext) {
  server.handle(listAccountsRpc, () => listAccounts());
  server.handle(useAccountRpc, ({ id }) => useAccount(id));
  return () => {};
}
