import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Account } from "../shared/contracts";
import type { Strings } from "./i18n";
import { meterColor, type Styles } from "./styles";

const LOGIN_WARNING_MS = 7 * 24 * 60 * 60_000;
const STALE_MS = 5 * 60_000;

interface MeterProps {
  label: string;
  reading: { percent: number; resetsAt: string | null } | null;
  now: number;
  s: Styles;
  text: Strings;
}

function Meter({ label, reading, now, s, text }: MeterProps) {
  const percent = reading === null ? null : Math.round(reading.percent);
  return (
    <View
      style={s.meter}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={percent === null ? { text: text.t("noReading") } : { min: 0, max: 100, now: percent }}
    >
      <View style={s.meterHead}>
        <Text style={s.meterLabel}>{label}</Text>
        <Text style={s.meterValue}>{percent === null ? "–" : `${percent}%`}</Text>
      </View>
      <View style={s.track}>
        <View
          style={[
            s.bar,
            {
              width: `${percent ?? 0}%`,
              backgroundColor: percent === null ? s.colors.surface2 : meterColor(s.colors, percent),
            },
          ]}
        />
      </View>
      {reading?.resetsAt ? (
        <Text style={s.small}>{text.t("resetsIn", { time: text.relative(reading.resetsAt, now) })}</Text>
      ) : null}
    </View>
  );
}

export interface CardActions {
  onUse(account: Account): void;
  onMove(account: Account, by: -1 | 1): void;
  onWhere(account: Account): void;
  onSignIn(account: Account): void;
  onRename(account: Account): void;
  onRemove(account: Account): void;
}

interface SheetAction {
  icon: string;
  label: string;
  danger?: boolean;
  run(): void;
}

function ActionsSheet({
  title,
  actions,
  onClose,
  s,
}: {
  title: string;
  actions: SheetAction[];
  onClose(): void;
  s: Styles;
}) {
  return (
    <Modal title={title} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content contentContainerStyle={{ padding: 0, gap: 0 }}>
        {actions.map((action, index) => (
          <View key={action.label}>
            {index === 0 ? null : <View style={s.divider} />}
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                onClose();
                action.run();
              }}
              style={({ pressed }) => [s.sheetRow, pressed ? { backgroundColor: s.colors.surface2 } : null]}
            >
              <Icon name={action.icon} size={18} color={action.danger ? s.colors.statusDanger : s.colors.foreground} />
              <Text style={[s.body, action.danger ? { color: s.colors.statusDanger } : null]}>{action.label}</Text>
            </Pressable>
          </View>
        ))}
      </Modal.Content>
    </Modal>
  );
}

interface AccountCardProps {
  account: Account;
  count: number;
  // Project name for a workspace or project id.
  nameOf(id: string): string;
  busy: boolean;
  now: number;
  s: Styles;
  text: Strings;
  actions: CardActions;
}

export function AccountCard({ account, count, nameOf, busy, now, s, text, actions }: AccountCardProps) {
  const [menu, setMenu] = useState(false);
  const title = account.email || account.name || text.t("unidentified");
  const subtitle = [account.id, account.plan.replace(/^claude_/, ""), account.organization]
    .filter((part) => part !== "")
    .join(" · ");
  const loginEndsSoon =
    account.status === "ready" &&
    account.loginExpiresAt !== null &&
    Date.parse(account.loginExpiresAt) - now < LOGIN_WARNING_MS;
  const live = account.active || account.usedBy.length > 0;
  const names = (ids: string[]) => {
    const shown = [...new Set(ids.map(nameOf))].sort();
    return shown.length <= 2 ? shown.join(", ") : `${shown.slice(0, 2).join(", ")} +${shown.length - 2}`;
  };
  const badge = account.active
    ? text.t("active")
    : account.usedBy.length > 0
      ? text.t("inUseIn", { project: names(account.usedBy) })
      : null;
  const scope = account.everywhere
    ? text.t("scopeAll")
    : text.t("scopeOnly", { projects: names(account.allowed) || "–" });
  const staleSince =
    account.usage !== null && now - Date.parse(account.usage.fetchedAt) > STALE_MS ? account.usage.fetchedAt : null;

  const sheet: SheetAction[] = [
    ...(account.priority > 1
      ? [{ icon: "ArrowUp", label: text.t("moveUp"), run: () => actions.onMove(account, -1) }]
      : []),
    ...(account.priority < count
      ? [{ icon: "ArrowDown", label: text.t("moveDown"), run: () => actions.onMove(account, 1) }]
      : []),
    { icon: "FolderLock", label: text.t("whereAction"), run: () => actions.onWhere(account) },
    ...(account.status === "ready" && !live
      ? [{ icon: "RefreshCw", label: text.t("signInAgain"), run: () => actions.onSignIn(account) }]
      : []),
    { icon: "Pencil", label: text.t("rename"), run: () => actions.onRename(account) },
    ...(live ? [] : [{ icon: "Trash2", label: text.t("remove"), danger: true, run: () => actions.onRemove(account) }]),
  ];

  const signIn = (
    <Pressable
      accessibilityRole="button"
      onPress={() => actions.onSignIn(account)}
      style={[s.primary, s.compact ? s.fill : null]}
    >
      <Icon name="LogIn" size={16} color={s.colors.accentForeground} />
      <Text style={s.primaryText}>{text.t("signIn")}</Text>
    </Pressable>
  );
  const useFirst = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${text.t("useFirst")} ${title}`}
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      onPress={() => actions.onUse(account)}
      style={[s.primary, s.compact ? s.fill : null, busy ? s.disabled : null]}
    >
      <Icon name="ArrowLeftRight" size={16} color={s.colors.accentForeground} />
      <Text style={s.primaryText}>{busy ? text.t("switching") : text.t("useFirst")}</Text>
    </Pressable>
  );
  const primary = account.status !== "ready" ? signIn : account.active || account.priority === 1 ? null : useFirst;

  const more = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={text.t("actions", { name: title })}
      hitSlop={8}
      onPress={() => setMenu(true)}
      style={s.iconButton}
    >
      <Icon name="Ellipsis" size={18} color={s.colors.foreground} />
    </Pressable>
  );

  return (
    <View style={[s.card, live ? s.activeCard : null]}>
      <View style={s.row}>
        <View
          style={[s.avatar, live ? s.avatarActive : null]}
          accessible
          accessibilityLabel={text.t("priorityLabel", { n: account.priority })}
        >
          <Text style={[s.avatarText, live ? s.avatarTextActive : null]}>{account.priority}</Text>
        </View>
        <View style={s.grow}>
          <View style={s.wrapRow}>
            <Text style={[s.email, { flexShrink: 1 }]} numberOfLines={1}>
              {title}
            </Text>
            {badge === null ? null : (
              <View style={s.badge}>
                <Text style={s.badgeText} numberOfLines={1}>
                  {badge}
                </Text>
              </View>
            )}
          </View>
          <Text style={s.muted} numberOfLines={1}>
            {subtitle}
          </Text>
          <View style={[s.wrapRow, { gap: 4 }]}>
            <Icon name={account.everywhere ? "Globe" : "FolderLock"} size={12} color={s.colors.foregroundMuted} />
            <Text style={s.small} numberOfLines={1}>
              {scope}
            </Text>
          </View>
        </View>
        {s.compact ? null : primary}
        {more}
      </View>

      {account.status === "no-login" ? null : (
        <View style={s.meters}>
          <Meter label={text.t("session")} reading={account.usage?.fiveHour ?? null} now={now} s={s} text={text} />
          <Meter label={text.t("week")} reading={account.usage?.week ?? null} now={now} s={s} text={text} />
        </View>
      )}

      {account.status === "no-login" ? <Text style={s.warning}>{text.t("statusNoLogin")}</Text> : null}
      {account.status === "relogin" ? <Text style={s.danger}>{text.t("statusRelogin")}</Text> : null}
      {account.exhaustedUntil !== null ? (
        <Text style={s.warning}>{text.t("exhausted", { time: text.relative(account.exhaustedUntil, now) })}</Text>
      ) : null}
      {loginEndsSoon && account.loginExpiresAt !== null ? (
        <Text style={s.warning}>
          {text.t("loginExpiresSoon", { time: text.relative(account.loginExpiresAt, now) })}
        </Text>
      ) : null}
      {staleSince !== null ? (
        <Text style={s.small}>{text.t("readingAge", { time: text.relative(staleSince, now) })}</Text>
      ) : null}

      {s.compact && primary !== null ? <View style={s.row}>{primary}</View> : null}

      {menu ? <ActionsSheet title={title} actions={sheet} onClose={() => setMenu(false)} s={s} /> : null}
    </View>
  );
}
