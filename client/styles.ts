import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";

/** Every style of the plugin, from the host theme so light and dark both read well. */
export function useStyles(theme: PluginTheme, compact: boolean) {
  return useMemo(() => {
    const c = theme.colors;
    return {
      colors: c,
      screen: { flex: 1, backgroundColor: c.surface0 },
      content: { padding: compact ? 16 : 24, gap: compact ? 12 : 16, maxWidth: 760, width: "100%" as const, alignSelf: "center" as const },
      header: { gap: 6 },
      headerRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      title: { color: c.foreground, fontSize: compact ? 20 : 24, fontWeight: "700" as const, flexGrow: 1 },
      body: { color: c.foreground, fontSize: 14, lineHeight: 20 },
      muted: { color: c.foregroundMuted, fontSize: 12, lineHeight: 17 },
      small: { color: c.foregroundMuted, fontSize: 11 },
      danger: { color: c.statusDanger, fontSize: 12, lineHeight: 17 },
      warning: { color: c.statusWarning, fontSize: 12, lineHeight: 17 },
      sectionTitle: { color: c.foregroundMuted, fontSize: 12, fontWeight: "600" as const, textTransform: "uppercase" as const, letterSpacing: 0.6, marginTop: 8 },
      card: { gap: 12, padding: compact ? 14 : 16, borderRadius: 12, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border },
      activeCard: { borderColor: c.accent },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12 },
      wrapRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      grow: { flex: 1, minWidth: 0, gap: 2 },
      avatar: { width: 36, height: 36, borderRadius: 18, alignItems: "center" as const, justifyContent: "center" as const, backgroundColor: c.surface2 },
      avatarActive: { backgroundColor: c.accent },
      avatarText: { color: c.foreground, fontSize: 15, fontWeight: "700" as const },
      avatarTextActive: { color: c.accentForeground },
      email: { color: c.foreground, fontSize: 15, fontWeight: "600" as const },
      badge: { paddingVertical: 3, paddingHorizontal: 8, borderRadius: 999, backgroundColor: c.accent },
      badgeText: { color: c.accentForeground, fontSize: 11, fontWeight: "700" as const },
      primary: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "center" as const, gap: 6, paddingVertical: 9, paddingHorizontal: 16, borderRadius: 8, backgroundColor: c.accent },
      primaryText: { color: c.accentForeground, fontSize: 13, fontWeight: "600" as const },
      secondary: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "center" as const, gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.surface2 },
      secondaryText: { color: c.foreground, fontSize: 13, fontWeight: "500" as const },
      dangerButton: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "center" as const, gap: 6, paddingVertical: 9, paddingHorizontal: 16, borderRadius: 8, backgroundColor: c.statusDanger },
      ghost: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4, paddingVertical: 4, paddingHorizontal: 6, borderRadius: 6 },
      ghostText: { color: c.foregroundMuted, fontSize: 12, fontWeight: "500" as const },
      disabled: { opacity: 0.5 },
      meters: { flexDirection: compact ? ("column" as const) : ("row" as const), gap: compact ? 10 : 16 },
      meter: { flex: compact ? undefined : 1, gap: 4 },
      meterHead: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 8 },
      meterLabel: { color: c.foregroundMuted, fontSize: 12, fontWeight: "500" as const },
      meterValue: { color: c.foreground, fontSize: 12, fontWeight: "600" as const },
      track: { height: 6, borderRadius: 3, backgroundColor: c.surface2, overflow: "hidden" as const },
      input: { borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 12, color: c.foreground, backgroundColor: c.surface0, fontSize: 14 },
      divider: { height: 1, backgroundColor: c.border },
      historyRow: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 12, paddingVertical: 8 },
    };
  }, [theme, compact]);
}

export type Styles = ReturnType<typeof useStyles>;

/** The color of a meter: calm, then warning, then danger as the window fills. */
export function meterColor(colors: PluginTheme["colors"], percent: number): string {
  if (percent >= 90) return colors.statusDanger;
  if (percent >= 70) return colors.statusWarning;
  return colors.accent;
}
