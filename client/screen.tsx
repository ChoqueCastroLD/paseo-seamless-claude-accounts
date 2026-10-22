import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { listAccounts, preferences, useAccount, type Account, type HistoryEntry } from "../shared/contracts";
import { AccountCard } from "./account-card";
import { LoginDialog, RemoveDialog, RenameDialog } from "./dialogs";
import { useStrings, type Strings } from "./i18n";
import { useStyles, type Styles } from "./styles";

export const ACCOUNTS_QUERY = ["seamless-claude-accounts", "list"] as const;
/** The meters move slowly and the endpoint rate-limits; a minute is fresh enough. */
export const POLL_MS = 60_000;

/** Ids of the screens and settings pages, shared by every entry point that opens them. */
export const SCREEN_ID = "accounts";
export const SETTINGS_ID = "preferences";

function AutoSwitchSummary({ s, text, onOpenSettings }: { s: Styles; text: Strings; onOpenSettings(): void }) {
  const settings = useSettings(preferences);
  if (settings.status !== "ready") return null;
  const prefs = settings.values;
  const summary = prefs.autoSwitch
    ? text.t("autoSummary", {
        threshold: prefs.preemptive ? text.t("autoThreshold", { session: prefs.sessionThreshold, week: prefs.weekThreshold }) : "",
        resume: prefs.autoContinue ? text.t("autoResume") : text.t("autoNoResume"),
      })
    : "";
  return (
    <Pressable accessibilityRole="button" onPress={onOpenSettings} style={[s.card, { gap: 6 }]}>
      <View style={s.wrapRow}>
        <Icon name={prefs.autoSwitch ? "Zap" : "ZapOff"} size={14} color={prefs.autoSwitch ? s.colors.accent : s.colors.foregroundMuted} />
        <Text style={[s.body, { fontWeight: "600", flex: 1 }]}>{prefs.autoSwitch ? text.t("autoOn") : text.t("autoOff")}</Text>
        <Icon name="Settings" size={14} color={s.colors.foregroundMuted} />
      </View>
      {summary === "" ? null : <Text style={s.muted}>{summary}</Text>}
    </Pressable>
  );
}

function History({ entries, s, text }: { entries: HistoryEntry[]; s: Styles; text: Strings }) {
  if (entries.length === 0) return null;
  const reason = { manual: text.t("reasonManual"), limit: text.t("reasonLimit"), threshold: text.t("reasonThreshold") };
  return (
    <View style={{ gap: 4 }}>
      <Text style={s.sectionTitle}>{text.t("history")}</Text>
      <View style={[s.card, { gap: 0, paddingVertical: 4 }]}>
        {entries.map((entry, index) => (
          <View key={`${entry.at}-${index}`}>
            {index === 0 ? null : <View style={s.divider} />}
            <View style={s.historyRow}>
              <View style={s.grow}>
                <Text style={s.body}>{text.t("historyEntry", { from: entry.from || "–", to: entry.to })}</Text>
                <Text style={s.small}>
                  {[reason[entry.reason], entry.resumed > 0 ? text.plural("resumedChats", entry.resumed) : ""].filter((part) => part !== "").join(" · ")}
                </Text>
              </View>
              <Text style={s.small}>{text.relative(entry.at)}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

export function AccountsScreen({ theme, layout, openSettings }: PluginScreenProps & { openSettings(id: string): void }) {
  const s = useStyles(theme, layout.compact);
  const text = useStrings();
  const toast = useToast();
  const client = useQueryClient();
  const list = useRpc(listAccounts);
  const use = useRpc(useAccount);
  const [login, setLogin] = useState<{ profile: string | null } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const query = useQuery({ queryKey: ACCOUNTS_QUERY, queryFn: () => list({ refresh: false }), refetchInterval: POLL_MS });
  const refresh = useMutation({
    mutationFn: () => list({ refresh: true }),
    onSuccess: (data) => client.setQueryData(ACCOUNTS_QUERY, data),
  });
  const switching = useMutation({
    mutationFn: (account: Account) => use({ id: account.id }),
    onSuccess: async (result) => {
      if (result.ok) toast.show(text.t("nowUsing", { email: result.email }), { variant: "success" });
      else toast.error(text.error(result.error, result.detail));
      await client.invalidateQueries({ queryKey: ACCOUNTS_QUERY });
    },
    onError: (error: unknown) => toast.error(text.error("io", String(error))),
  });
  const reload = () => void client.invalidateQueries({ queryKey: ACCOUNTS_QUERY });

  const accounts = query.data?.accounts ?? [];

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      <View style={s.header}>
        <View style={s.headerRow}>
          <Text style={s.title}>{text.t("title")}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={text.t("refresh")}
            disabled={refresh.isPending}
            onPress={() => refresh.mutate()}
            style={[s.secondary, refresh.isPending ? s.disabled : null]}
          >
            <Icon name="RefreshCw" size={14} color={s.colors.foreground} />
            {layout.compact ? null : <Text style={s.secondaryText}>{text.t("refresh")}</Text>}
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => setLogin({ profile: null })} style={s.primary}>
            <Icon name="UserPlus" size={14} color={s.colors.accentForeground} />
            <Text style={s.primaryText}>{text.t("addAccount")}</Text>
          </Pressable>
        </View>
        <Text style={s.muted}>{text.t("intro")}</Text>
        {query.data === undefined ? null : (
          <Text style={s.small} selectable>
            {query.data.target}
          </Text>
        )}
      </View>

      <AutoSwitchSummary s={s} text={text} onOpenSettings={() => openSettings(SETTINGS_ID)} />

      {query.isLoading ? <Text style={s.muted}>{text.t("loading")}</Text> : null}
      {query.isError ? <Text style={s.danger}>{text.t("loadFailed", { detail: String(query.error) })}</Text> : null}
      {query.isSuccess && accounts.length === 0 ? <Text style={s.muted}>{text.t("empty")}</Text> : null}

      {accounts.map((account) => (
        <AccountCard
          key={account.id}
          account={account}
          busy={switching.isPending}
          s={s}
          text={text}
          actions={{
            onUse: (target) => switching.mutate(target),
            onSignIn: (target) => setLogin({ profile: target.id }),
            onRename: (target) => setRenaming(target.id),
            onRemove: (target) => setRemoving(target.id),
          }}
        />
      ))}

      <History entries={query.data?.history ?? []} s={s} text={text} />

      <LoginDialog
        open={login !== null}
        profile={login?.profile ?? null}
        onClose={() => setLogin(null)}
        onDone={() => {
          setLogin(null);
          reload();
        }}
        s={s}
        text={text}
      />
      <RenameDialog
        id={renaming}
        onClose={() => setRenaming(null)}
        onDone={() => {
          setRenaming(null);
          reload();
        }}
        s={s}
        text={text}
      />
      <RemoveDialog
        id={removing}
        onClose={() => setRemoving(null)}
        onDone={() => {
          setRemoving(null);
          reload();
        }}
        s={s}
        text={text}
      />
    </ScrollView>
  );
}
