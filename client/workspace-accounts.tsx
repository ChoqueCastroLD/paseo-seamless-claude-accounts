import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { assignWorkspace, listAccounts } from "../shared/contracts";
import { useStrings } from "./i18n";
import { ACCOUNTS_QUERY, POLL_MS } from "./screen";
import { useStyles } from "./styles";

function Check({
  label,
  hint,
  selected,
  round,
  onPress,
  color,
  muted,
  text,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  round: boolean;
  onPress(): void;
  color: string;
  muted: string;
  text: object;
}) {
  const icon = round ? (selected ? "CircleDot" : "Circle") : selected ? "SquareCheckBig" : "Square";
  return (
    <Pressable
      accessibilityRole={round ? "radio" : "checkbox"}
      accessibilityState={round ? { selected } : { checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [
        { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 },
        pressed ? { opacity: 0.7 } : null,
      ]}
    >
      <Icon name={icon} size={20} color={selected ? color : muted} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={text} numberOfLines={1}>
          {label}
        </Text>
        {hint === undefined ? null : <Text style={{ color: muted, fontSize: 12 }}>{hint}</Text>}
      </View>
    </Pressable>
  );
}

/** Chooses the accounts one workspace may use, right from its header. */
export function WorkspaceAccounts({ theme, layout, workspaceId, close }: PluginButtonContentProps) {
  const s = useStyles(theme, layout.compact);
  const text = useStrings();
  const toast = useToast();
  const client = useQueryClient();
  const list = useRpc(listAccounts);
  const assign = useRpc(assignWorkspace);
  const query = useQuery({
    queryKey: ACCOUNTS_QUERY,
    queryFn: () => list({ refresh: false }),
    refetchInterval: POLL_MS,
  });
  const [draft, setDraft] = useState<{ follow: boolean; chosen: Set<string> } | null>(null);
  const [busy, setBusy] = useState(false);

  const data = query.data;
  if (data === undefined) return <Text style={s.muted}>{text.t("loading")}</Text>;
  const workspace = data.workspaces.find((entry) => entry.id === workspaceId);
  const project = data.projects.find((entry) => entry.id === workspace?.projectId);
  const excluded = new Set(data.excluded[workspace?.projectId ?? ""] ?? []);
  const fromProject = data.accounts.filter((account) => !excluded.has(account.id)).map((account) => account.id);
  const saved = data.choices[workspaceId];
  const state = draft ?? { follow: saved === undefined, chosen: new Set(saved ?? fromProject) };
  const inUse =
    data.accounts.find((account) => account.usedBy.includes(workspaceId)) ??
    data.accounts.find((account) => account.usedBy.includes(workspace?.projectId ?? "")) ??
    data.accounts.find((account) => account.active);

  const toggle = (id: string) => {
    const chosen = new Set(state.chosen);
    if (chosen.has(id)) chosen.delete(id);
    else chosen.add(id);
    setDraft({ follow: false, chosen });
  };

  async function save(accountsList: { id: string }[]) {
    setBusy(true);
    const accounts = state.follow
      ? null
      : accountsList.map((account) => account.id).filter((id) => state.chosen.has(id));
    const result = await assign({ workspaceId, accounts }).catch((cause: unknown) => ({
      ok: false as const,
      error: "io" as const,
      detail: String(cause),
    }));
    setBusy(false);
    if (!result.ok) return toast.error(text.error(result.error, result.detail));
    await client.invalidateQueries({ queryKey: ACCOUNTS_QUERY });
    toast.show(text.t("whereSaved"), { variant: "success" });
    close();
  }

  const changed =
    draft !== null &&
    (draft.follow !== (saved === undefined) ||
      (!draft.follow && [...draft.chosen].sort().join() !== [...(saved ?? fromProject)].sort().join()));

  return (
    <View style={{ gap: 12, padding: layout.compact ? 4 : 0, minWidth: layout.compact ? undefined : 320 }}>
      <Text style={[s.body, { fontWeight: "600" }]}>{text.t("workspaceTitle")}</Text>
      {inUse === undefined ? null : (
        <Text style={s.muted}>{text.t("workspaceInUse", { email: inUse.email || inUse.id })}</Text>
      )}
      <View>
        <Check
          label={text.t("workspaceFollow", { project: project?.name ?? "–" })}
          hint={text.t("workspaceFollowHint")}
          selected={state.follow}
          round
          onPress={() => setDraft({ follow: true, chosen: new Set(fromProject) })}
          color={s.colors.accent}
          muted={s.colors.foregroundMuted}
          text={s.body}
        />
        <Check
          label={text.t("workspaceChoose")}
          selected={!state.follow}
          round
          onPress={() => setDraft({ follow: false, chosen: state.chosen })}
          color={s.colors.accent}
          muted={s.colors.foregroundMuted}
          text={s.body}
        />
      </View>
      <View style={[s.card, { gap: 0, paddingVertical: 4, opacity: state.follow ? 0.6 : 1 }]}>
        {data.accounts.map((account) => (
          <Check
            key={account.id}
            label={`${account.priority}. ${account.email || account.id}`}
            selected={state.chosen.has(account.id)}
            round={false}
            onPress={() => toggle(account.id)}
            color={s.colors.accent}
            muted={s.colors.foregroundMuted}
            text={s.body}
          />
        ))}
      </View>
      <View style={s.dialogActions}>
        <Pressable accessibilityRole="button" onPress={close} style={s.secondary}>
          <Text style={s.secondaryText}>{text.t("cancel")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy || !changed || (!state.follow && state.chosen.size === 0) }}
          disabled={busy || !changed || (!state.follow && state.chosen.size === 0)}
          onPress={() => void save(data.accounts)}
          style={[s.primary, busy || !changed || (!state.follow && state.chosen.size === 0) ? s.disabled : null]}
        >
          <Text style={s.primaryText}>{text.t("save")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Adds the accounts button to every workspace header, including ones created later. */
export function contributeWorkspaceButtons(client: PluginClientContext, title: string): () => void {
  const buttons = new Map<string, { remove(): void }>();
  let stopped = false;
  let release: (() => Promise<void>) | null = null;
  const add = (workspaceId: string) => {
    if (stopped || buttons.has(workspaceId)) return;
    buttons.set(
      workspaceId,
      client.addHeaderButton({
        id: "claude-accounts",
        workspaceId,
        button: { title, icon: "Users", behavior: { kind: "popover", Content: WorkspaceAccounts } },
      }),
    );
  };
  const drop = (workspaceId: string) => {
    buttons.get(workspaceId)?.remove();
    buttons.delete(workspaceId);
  };
  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      if (stopped) return subscription.release();
      release = () => subscription.release();
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const ids = new Set(entries.map((workspace) => workspace.id));
          for (const id of [...buttons.keys()]) if (!ids.has(id)) drop(id);
          for (const id of ids) add(id);
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          if (message.payload.kind === "upsert") add(message.payload.workspace.id);
          else drop(message.payload.id);
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!stopped) console.warn("[seamless-claude-accounts]", error);
    });
  return () => {
    stopped = true;
    void release?.();
    for (const id of [...buttons.keys()]) drop(id);
  };
}
