import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { listAccounts, preferences, switchAccount, type Account, type HistoryEntry } from "../shared/contracts";
import { AccountCard } from "./account-card";
import { useNow } from "./clock";
import { LoginDialog, RemoveDialog, RenameDialog } from "./dialogs";
import { useStrings, type Strings } from "./i18n";
import { useStyles, type Styles } from "./styles";

export const ACCOUNTS_QUERY = ["seamless-claude-accounts", "list"] as const;
export const POLL_MS = 60_000;
export const SCREEN_ID = "accounts";
export const SETTINGS_ID = "preferences";

type Dialog =
  { kind: "login"; profile: string | null } | { kind: "rename"; id: string } | { kind: "remove"; id: string };

function AutoSwitchSummary({ s, text, onPress }: { s: Styles; text: Strings; onPress(): void }) {
  const settings = useSettings(preferences);
  if (settings.status !== "ready") return null;
  const prefs = settings.values;
  const summary = prefs.autoSwitch
    ? text.t("autoSummary", {
        threshold: prefs.preemptive
          ? text.t("autoThreshold", { session: prefs.sessionThreshold, week: prefs.weekThreshold })
          : "",
        resume: prefs.autoContinue ? text.t("autoResume") : text.t("autoNoResume"),
      })
    : null;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [s.card, { gap: 6 }, pressed ? { backgroundColor: s.colors.surface2 } : null]}
    >
      <View style={s.row}>
        <Icon
          name={prefs.autoSwitch ? "Zap" : "ZapOff"}
          size={16}
          color={prefs.autoSwitch ? s.colors.accent : s.colors.foregroundMuted}
        />
        <Text style={[s.body, s.fill, { fontWeight: "600" }]}>
          {prefs.autoSwitch ? text.t("autoOn") : text.t("autoOff")}
        </Text>
        <Icon name="ChevronRight" size={16} color={s.colors.foregroundMuted} />
      </View>
      {summary === null ? null : <Text style={s.muted}>{summary}</Text>}
    </Pressable>
  );
}

function History({ entries, now, s, text }: { entries: HistoryEntry[]; now: number; s: Styles; text: Strings }) {
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
                <Text style={s.body} numberOfLines={1}>
                  {text.t("historyEntry", { from: entry.from || "–", to: entry.to })}
                </Text>
                <Text style={s.small}>
                  {[reason[entry.reason], entry.resumed > 0 ? text.plural("resumedChats", entry.resumed) : ""]
                    .filter((part) => part !== "")
                    .join(" · ")}
                </Text>
              </View>
              <Text style={s.small}>{text.relative(entry.at, now)}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

export function AccountsScreen({
  theme,
  layout,
  openSettings,
}: PluginScreenProps & { openSettings(id: string): void }) {
  const s = useStyles(theme, layout.compact);
  const text = useStrings();
  const now = useNow();
  const toast = useToast();
  const client = useQueryClient();
  const list = useRpc(listAccounts);
  const switchTo = useRpc(switchAccount);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const query = useQuery({
    queryKey: ACCOUNTS_QUERY,
    queryFn: () => list({ refresh: false }),
    refetchInterval: POLL_MS,
  });
  const refresh = useMutation({
    mutationFn: () => list({ refresh: true }),
    onSuccess: (data) => client.setQueryData(ACCOUNTS_QUERY, data),
    onError: (error: unknown) => toast.error(text.error("io", String(error))),
  });
  const switching = useMutation({
    mutationFn: (account: Account) => switchTo({ id: account.id }),
    onSuccess: async (result) => {
      if (result.ok) toast.show(text.t("nowUsing", { email: result.email }), { variant: "success" });
      else toast.error(text.error(result.error, result.detail));
      await client.invalidateQueries({ queryKey: ACCOUNTS_QUERY });
    },
    onError: (error: unknown) => toast.error(text.error("io", String(error))),
  });

  const close = () => setDialog(null);
  const done = () => {
    setDialog(null);
    void client.invalidateQueries({ queryKey: ACCOUNTS_QUERY });
  };
  const accounts = query.data?.accounts ?? [];

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <View style={s.header}>
        <View style={s.headerRow}>
          <Text style={s.title} numberOfLines={1}>
            {text.t("title")}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={text.t("refresh")}
            accessibilityState={{ busy: refresh.isPending }}
            disabled={refresh.isPending}
            onPress={() => refresh.mutate()}
            style={[layout.compact ? s.iconButton : s.secondary, refresh.isPending ? s.disabled : null]}
          >
            <Icon name="RefreshCw" size={16} color={s.colors.foreground} />
            {layout.compact ? null : <Text style={s.secondaryText}>{text.t("refresh")}</Text>}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={text.t("addAccount")}
            onPress={() => setDialog({ kind: "login", profile: null })}
            style={layout.compact ? [s.iconButton, { backgroundColor: s.colors.accent }] : s.primary}
          >
            <Icon name="UserPlus" size={16} color={s.colors.accentForeground} />
            {layout.compact ? null : <Text style={s.primaryText}>{text.t("addAccount")}</Text>}
          </Pressable>
        </View>
        <Text style={s.muted}>{text.t("intro")}</Text>
      </View>

      <AutoSwitchSummary s={s} text={text} onPress={() => openSettings(SETTINGS_ID)} />

      {query.isLoading ? <Text style={s.muted}>{text.t("loading")}</Text> : null}
      {query.isError ? <Text style={s.danger}>{text.t("loadFailed", { detail: String(query.error) })}</Text> : null}
      {query.isSuccess && accounts.length === 0 ? <Text style={s.muted}>{text.t("empty")}</Text> : null}

      {accounts.map((account) => (
        <AccountCard
          key={account.id}
          account={account}
          busy={switching.isPending}
          now={now}
          s={s}
          text={text}
          actions={{
            onUse: (target) => switching.mutate(target),
            onSignIn: (target) => setDialog({ kind: "login", profile: target.id }),
            onRename: (target) => setDialog({ kind: "rename", id: target.id }),
            onRemove: (target) => setDialog({ kind: "remove", id: target.id }),
          }}
        />
      ))}

      <History entries={query.data?.history ?? []} now={now} s={s} text={text} />

      {query.data === undefined ? null : (
        <Text style={s.small} selectable>
          {query.data.target}
        </Text>
      )}

      {dialog?.kind === "login" ? (
        <LoginDialog profile={dialog.profile} onClose={close} onDone={done} s={s} text={text} />
      ) : null}
      {dialog?.kind === "rename" ? (
        <RenameDialog id={dialog.id} onClose={close} onDone={done} s={s} text={text} />
      ) : null}
      {dialog?.kind === "remove" ? (
        <RemoveDialog id={dialog.id} onClose={close} onDone={done} s={s} text={text} />
      ) : null}
    </ScrollView>
  );
}
