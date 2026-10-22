import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import type { SwitchRow } from "../shared/contracts";
import { useStrings } from "./i18n";

/** The note an automatic switch leaves in each chat it touched. */
export function SwitchNotice({ item, theme }: PluginTimelineItemProps<SwitchRow>) {
  const text = useStrings();
  const { from, to, reason, nextReset } = item.data;
  const exhausted = to === null;
  const color = exhausted ? theme.colors.statusWarning : theme.colors.accent;
  const message = exhausted
    ? [text.t("rowExhausted"), nextReset === null ? "" : text.t("rowNextReset", { time: text.relative(nextReset) })].filter(Boolean).join(" ")
    : text.t(reason === "threshold" ? "rowSwitchedThreshold" : "rowSwitched", { from: from || "–", to });
  return (
    <View
      accessibilityRole="text"
      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}
    >
      <Icon name={exhausted ? "CircleAlert" : "ArrowLeftRight"} size={14} color={color} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, flex: 1 }}>{message}</Text>
    </View>
  );
}
