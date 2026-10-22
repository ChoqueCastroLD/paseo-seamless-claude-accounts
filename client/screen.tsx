import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { listAccounts, useAccount } from "../shared/accounts";

/** A labelled allowance bar. Percent, so 0 and 100 look different at a glance. */
function Meter({ label, percent, theme }: { label: string; percent: number | null; theme: PluginScreenProps["theme"] }) {
  const value = percent === null ? null : Math.max(0, Math.min(100, percent));
  const fill = value === null ? theme.colors.surface2 : value >= 90 ? theme.colors.statusDanger : value >= 70 ? theme.colors.statusWarning : theme.colors.accent;
  return (
    <View style={{ gap: 4, flex: 1 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
        {label} {value === null ? "—" : `${Math.round(value)}%`}
      </Text>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
        <View style={{ height: 6, borderRadius: 3, width: `${value ?? 0}%` as `${number}%`, backgroundColor: fill }} />
      </View>
    </View>
  );
}

export function AccountsScreen({ theme, layout }: PluginScreenProps) {
  const list = useRpc(listAccounts);
  const use = useRpc(useAccount);
  const [message, setMessage] = useState("");
  const query = useQuery({ queryKey: ["claude-switch", "accounts"], queryFn: () => list({}) });
  const mutation = useMutation({
    mutationFn: (id: string) => use({ id }),
    onSuccess: async (result) => {
      setMessage(result.ok ? `Ahora: ${result.email}` : `No se pudo: ${result.error}`);
      await query.refetch();
    },
    onError: (error: unknown) => setMessage(`No se pudo: ${String(error)}`),
  });

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 16 : 24, gap: 12 },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 22, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      card: {
        gap: 10,
        padding: layout.compact ? 12 : 16,
        borderRadius: 12,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      activeCard: { borderColor: theme.colors.accent, borderWidth: 2 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
      email: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
      button: {
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
        alignSelf: "flex-start" as const,
      },
      buttonIdle: { backgroundColor: theme.colors.surface2 },
      buttonText: { color: theme.colors.accentForeground, fontSize: 13, fontWeight: "600" as const },
      buttonTextIdle: { color: theme.colors.foregroundMuted },
      badge: { color: theme.colors.accent, fontSize: 11, fontWeight: "600" as const },
    }),
    [theme, layout.compact],
  );

  const accounts = query.data?.accounts ?? [];

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Cuentas Claude</Text>
      <Text style={styles.muted}>
        Activa: {query.data?.email || "—"}
        {query.data === undefined ? "" : `  ·  ${query.data.target}`}
      </Text>
      <Text style={styles.muted}>
        Cambiar reescribe el fichero de credenciales, igual que `claude login`. Los chats abiertos no se reinician:
        siguen con su historial y usan la cuenta nueva en el siguiente mensaje.
      </Text>
      {message === "" ? null : <Text style={styles.muted}>{message}</Text>}
      {query.isLoading ? <Text style={styles.muted}>Leyendo cuentas…</Text> : null}
      {accounts.map((account) => (
        <View key={account.id} style={[styles.card, account.active ? styles.activeCard : null]}>
          <View style={styles.row}>
            <Text style={styles.email}>{account.email}</Text>
            {account.active ? <Text style={styles.badge}>activa</Text> : null}
          </View>
          <Text style={styles.muted}>
            {account.id}
            {account.plan === "" ? "" : `  ·  ${account.plan}`}
          </Text>
          <View style={styles.row}>
            <Meter label="5 h" percent={account.fiveHour} theme={theme} />
            <Meter label="7 días" percent={account.week} theme={theme} />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Usar ${account.email}`}
            disabled={account.active || mutation.isPending}
            onPress={() => mutation.mutate(account.id)}
            style={[styles.button, account.active || mutation.isPending ? styles.buttonIdle : null]}
          >
            <Text style={account.active || mutation.isPending ? styles.buttonTextIdle : styles.buttonText}>
              {account.active ? "En uso" : mutation.isPending ? "Cambiando…" : "Usar esta"}
            </Text>
          </Pressable>
        </View>
      ))}
      {query.isError ? <Text style={styles.muted}>No se pudieron leer las cuentas: {String(query.error)}</Text> : null}
    </ScrollView>
  );
}
