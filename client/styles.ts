import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";

export function useStyles(theme: PluginTheme, compact: boolean) {
  return useMemo(() => {
    const c = theme.colors;
    const target = compact ? 44 : 34;
    const button = {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: 6,
      minHeight: target,
      paddingHorizontal: 14,
      borderRadius: 8,
    };
    return {
      compact,
      colors: c,
      screen: { flex: 1, backgroundColor: c.surface0 },
      content: {
        padding: compact ? 12 : 24,
        paddingBottom: compact ? 32 : 24,
        gap: 12,
        maxWidth: 760,
        width: "100%" as const,
        alignSelf: "center" as const,
      },
      header: { gap: 8 },
      headerRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      title: { color: c.foreground, fontSize: compact ? 20 : 24, fontWeight: "700" as const, flex: 1 },
      body: { color: c.foreground, fontSize: compact ? 15 : 14, lineHeight: compact ? 21 : 20 },
      muted: { color: c.foregroundMuted, fontSize: 13, lineHeight: 18 },
      small: { color: c.foregroundMuted, fontSize: 12 },
      danger: { color: c.statusDanger, fontSize: 13, lineHeight: 18 },
      warning: { color: c.statusWarning, fontSize: 13, lineHeight: 18 },
      sectionTitle: {
        color: c.foregroundMuted,
        fontSize: 12,
        fontWeight: "600" as const,
        textTransform: "uppercase" as const,
        letterSpacing: 0.6,
        marginTop: 8,
      },
      card: {
        gap: 12,
        padding: compact ? 14 : 16,
        borderRadius: 12,
        backgroundColor: c.surface1,
        borderWidth: 1,
        borderColor: c.border,
      },
      activeCard: { borderColor: c.accent },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12 },
      wrapRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      grow: { flex: 1, minWidth: 0, gap: 2 },
      avatar: {
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: c.surface2,
      },
      avatarActive: { backgroundColor: c.accent },
      avatarText: { color: c.foreground, fontSize: 16, fontWeight: "700" as const },
      avatarTextActive: { color: c.accentForeground },
      email: { color: c.foreground, fontSize: 15, fontWeight: "600" as const },
      badge: { paddingVertical: 3, paddingHorizontal: 8, borderRadius: 999, backgroundColor: c.accent },
      badgeText: { color: c.accentForeground, fontSize: 11, fontWeight: "700" as const },
      primary: { ...button, backgroundColor: c.accent },
      primaryText: { color: c.accentForeground, fontSize: 14, fontWeight: "600" as const },
      secondary: { ...button, backgroundColor: c.surface2 },
      secondaryText: { color: c.foreground, fontSize: 14, fontWeight: "500" as const },
      dangerButton: { ...button, backgroundColor: c.statusDanger },
      iconButton: {
        width: target,
        height: target,
        borderRadius: 8,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: c.surface2,
      },
      fill: { flex: 1 },
      disabled: { opacity: 0.5 },
      meters: { flexDirection: compact ? ("column" as const) : ("row" as const), gap: compact ? 12 : 16 },
      meter: { flex: compact ? undefined : 1, gap: 5 },
      meterHead: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 8 },
      meterLabel: { color: c.foregroundMuted, fontSize: 13, fontWeight: "500" as const },
      meterValue: { color: c.foreground, fontSize: 13, fontWeight: "600" as const },
      track: { height: 8, borderRadius: 4, backgroundColor: c.surface2, overflow: "hidden" as const },
      bar: { height: 8, borderRadius: 4 },
      input: {
        minHeight: target,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 8,
        paddingHorizontal: 12,
        color: c.foreground,
        backgroundColor: c.surface0,
        fontSize: 16,
      },
      dialogActions: compact
        ? { flexDirection: "column-reverse" as const, gap: 8 }
        : { flexDirection: "row" as const, justifyContent: "flex-end" as const, gap: 8 },
      sheetRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 12,
        minHeight: 52,
        paddingHorizontal: 16,
      },
      divider: { height: 1, backgroundColor: c.border },
      historyRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, paddingVertical: 10 },
    };
  }, [theme, compact]);
}

export type Styles = ReturnType<typeof useStyles>;

export function meterColor(colors: PluginTheme["colors"], percent: number): string {
  if (percent >= 90) return colors.statusDanger;
  if (percent >= 70) return colors.statusWarning;
  return colors.accent;
}
