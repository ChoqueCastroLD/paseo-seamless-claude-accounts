import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import type { Account } from "../shared/contracts";
import type { Strings } from "./i18n";
import { meterColor, type Styles } from "./styles";

/** A sign-in this close to lapsing is worth a warning on the card. */
const LOGIN_WARNING_MS = 7 * 24 * 60 * 60_000;
/** A reading older than this is labelled with its age. */
const STALE_MS = 5 * 60_000;

function Meter({ label, reading, s, text }: { label: string; reading: { percent: number; resetsAt: string | null } | null; s: Styles; text: Strings }) {
  const percent = reading?.percent ?? null;
  return (
    <View style={s.meter} accessible accessibilityLabel={`${label} ${percent === null ? text.t("noReading") : `${Math.round(percent)}%`}`}>
      <View style={s.meterHead}>
        <Text style={s.meterLabel}>{label}</Text>
        <Text style={s.meterValue}>{percent === null ? "–" : `${Math.round(percent)}%`}</Text>
      </View>
      <View style={s.track}>
        <View
          style={{
            height: 6,
            borderRadius: 3,
            width: `${percent ?? 0}%` as `${number}%`,
            backgroundColor: percent === null ? s.colors.surface2 : meterColor(s.colors, percent),
          }}
        />
      </View>
      <Text style={s.small}>{reading?.resetsAt == null ? " " : text.t("resetsIn", { time: text.relative(reading.resetsAt) })}</Text>
    </View>
  );
}

export interface CardActions {
  onUse(account: Account): void;
  onSignIn(account: Account): void;
  onRename(account: Account): void;
  onRemove(account: Account): void;
}

export function AccountCard({ account, busy, s, text, actions }: { account: Account; busy: boolean; s: Styles; text: Strings; actions: CardActions }) {
  const now = Date.now();
  const title = account.email || account.name || text.t("unidentified");
  const subtitle = [account.id, account.plan.replace(/^claude_/, ""), account.organization].filter((part) => part !== "").join(" · ");
  const usable = account.status === "ready";
  const loginEndsSoon = account.loginExpiresAt !== null && Date.parse(account.loginExpiresAt) - now < LOGIN_WARNING_MS;
  const stale = account.usage !== null && now - Date.parse(account.usage.fetchedAt) > STALE_MS;

  return (
    <View style={[s.card, account.active ? s.activeCard : null]}>
      <View style={s.row}>
        <View style={[s.avatar, account.active ? s.avatarActive : null]}>
          <Text style={[s.avatarText, account.active ? s.avatarTextActive : null]}>{title.charAt(0).toUpperCase()}</Text>
        </View>
        <View style={s.grow}>
          <Text style={s.email} numberOfLines={1}>
            {title}
          </Text>
          <Text style={s.muted} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        {account.active ? (
          <View style={s.badge}>
            <Text style={s.badgeText}>{text.t("active")}</Text>
          </View>
        ) : usable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${text.t("use")} ${title}`}
            disabled={busy}
            onPress={() => actions.onUse(account)}
            style={[s.primary, busy ? s.disabled : null]}
          >
            <Text style={s.primaryText}>{busy ? text.t("switching") : text.t("use")}</Text>
          </Pressable>
        ) : (
          <Pressable accessibilityRole="button" onPress={() => actions.onSignIn(account)} style={s.primary}>
            <Icon name="LogIn" size={14} color={s.colors.accentForeground} />
            <Text style={s.primaryText}>{text.t("signIn")}</Text>
          </Pressable>
        )}
      </View>

      {account.status === "no-login" ? null : (
        <View style={s.meters}>
          <Meter label={text.t("session")} reading={account.usage?.fiveHour ?? null} s={s} text={text} />
          <Meter label={text.t("week")} reading={account.usage?.week ?? null} s={s} text={text} />
        </View>
      )}

      {account.status === "no-login" ? <Text style={s.warning}>{text.t("statusNoLogin")}</Text> : null}
      {account.status === "relogin" ? <Text style={s.danger}>{text.t("statusRelogin")}</Text> : null}
      {account.exhaustedUntil !== null ? <Text style={s.warning}>{text.t("exhausted", { time: text.relative(account.exhaustedUntil) })}</Text> : null}
      {account.status === "ready" && loginEndsSoon && account.loginExpiresAt !== null ? (
        <Text style={s.warning}>{text.t("loginExpiresSoon", { time: text.relative(account.loginExpiresAt) })}</Text>
      ) : null}

      <View style={[s.wrapRow, { justifyContent: "space-between" }]}>
        <Text style={s.small}>{stale && account.usage !== null ? text.t("readingAge", { time: text.relative(account.usage.fetchedAt) }) : ""}</Text>
        <View style={s.wrapRow}>
          {account.status === "ready" && !account.active ? (
            <Pressable accessibilityRole="button" onPress={() => actions.onSignIn(account)} style={s.ghost}>
              <Icon name="RefreshCw" size={12} color={s.colors.foregroundMuted} />
              <Text style={s.ghostText}>{text.t("signInAgain")}</Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" onPress={() => actions.onRename(account)} style={s.ghost}>
            <Icon name="Pencil" size={12} color={s.colors.foregroundMuted} />
            <Text style={s.ghostText}>{text.t("rename")}</Text>
          </Pressable>
          {account.active ? null : (
            <Pressable accessibilityRole="button" onPress={() => actions.onRemove(account)} style={s.ghost}>
              <Icon name="Trash2" size={12} color={s.colors.foregroundMuted} />
              <Text style={s.ghostText}>{text.t("remove")}</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}
