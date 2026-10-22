import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { copyText, Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { cancelLogin, finishLogin, removeAccount, renameAccount, startLogin } from "../shared/contracts";
import { slug } from "../shared/names";
import type { Strings } from "./i18n";
import type { Styles } from "./styles";

function Button({ label, onPress, s, kind = "primary", disabled = false, icon }: {
  label: string;
  onPress(): void;
  s: Styles;
  kind?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  icon?: string;
}) {
  const style = kind === "primary" ? s.primary : kind === "danger" ? s.dangerButton : s.secondary;
  const textStyle = kind === "secondary" ? s.secondaryText : s.primaryText;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[style, disabled ? s.disabled : null]}>
      {icon === undefined ? null : <Icon name={icon} size={14} color={kind === "secondary" ? s.colors.foreground : s.colors.accentForeground} />}
      <Text style={textStyle}>{label}</Text>
    </Pressable>
  );
}

type LoginStep =
  | { kind: "name" }
  | { kind: "starting" }
  | { kind: "code"; session: string; url: string; id: string }
  | { kind: "finishing"; session: string; url: string; id: string };

/**
 * Adds an account, or signs an existing profile in again, without a terminal: the daemon runs
 * `claude auth login`, this shows its link, and the code from the browser goes back to it.
 */
export function LoginDialog({ open, profile, onClose, onDone, s, text }: {
  open: boolean;
  /** Set to sign an existing profile in again; null to add a new account. */
  profile: string | null;
  onClose(): void;
  onDone(): void;
  s: Styles;
  text: Strings;
}) {
  const start = useRpc(startLogin);
  const finish = useRpc(finishLogin);
  const cancel = useRpc(cancelLogin);
  const toast = useToast();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [step, setStep] = useState<LoginStep>({ kind: "name" });
  const session = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(profile ?? "");
    setCode("");
    setError("");
    setStep({ kind: "name" });
    if (profile !== null) void begin(profile);
    // Only a fresh opening restarts the flow.
  }, [open, profile]);

  async function begin(target: string) {
    setError("");
    setStep({ kind: "starting" });
    const result = await start({ name: target }).catch((cause: unknown) => ({ ok: false as const, error: "io" as const, detail: String(cause) }));
    if (!result.ok) {
      setError(text.error(result.error, result.detail));
      setStep({ kind: "name" });
      return;
    }
    session.current = result.session;
    setStep({ kind: "code", session: result.session, url: result.url, id: result.id });
  }

  async function complete() {
    if (step.kind !== "code") return;
    setError("");
    setStep({ ...step, kind: "finishing" });
    const result = await finish({ session: step.session, code }).catch((cause: unknown) => ({ ok: false as const, error: "io" as const, detail: String(cause) }));
    session.current = null;
    if (!result.ok) {
      setError(text.error(result.error, result.detail));
      // The CLI exits after one attempt, so a retry needs a new link.
      setCode("");
      setStep({ kind: "name" });
      return;
    }
    toast.show(text.t("loginDone", { email: result.email || result.id }), { variant: "success" });
    onDone();
  }

  function close() {
    if (session.current !== null) void cancel({ session: session.current });
    session.current = null;
    onClose();
  }

  const id = slug(name) ?? "";
  const title = profile === null ? text.t("loginTitle") : text.t("reloginTitle", { id: profile });

  return (
    <Modal title={title} icon={<Icon name="UserPlus" size={18} color={s.colors.foreground} />} open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <Modal.Content>
        {step.kind === "name" && profile === null ? (
          <View style={{ gap: 8 }}>
            <Text style={s.body}>{text.t("loginName")}</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="work"
              placeholderTextColor={s.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              onSubmitEditing={() => id !== "" && void begin(id)}
              style={s.input}
            />
            <Text style={s.muted}>{text.t("loginNameHint", { id: id || "…" })}</Text>
          </View>
        ) : null}

        {step.kind === "starting" ? <Text style={s.muted}>{text.t("loginStarting")}</Text> : null}

        {step.kind === "code" || step.kind === "finishing" ? (
          <View style={{ gap: 12 }}>
            <Text style={s.body}>{text.t("loginStep1")}</Text>
            <View style={s.wrapRow}>
              <Button label={text.t("loginOpen")} icon="ExternalLink" s={s} onPress={() => void openExternalUrl(step.url).catch(() => toast.error(step.url))} />
              <Button
                label={text.t("loginCopy")}
                icon="Copy"
                kind="secondary"
                s={s}
                onPress={() =>
                  void copyText(step.url).then(
                    () => toast.show(text.t("loginCopied"), { variant: "success" }),
                    () => toast.error(step.url),
                  )
                }
              />
            </View>
            <Text style={s.body}>{text.t("loginStep2")}</Text>
            <TextInput
              value={code}
              onChangeText={setCode}
              placeholder={text.t("loginCode")}
              placeholderTextColor={s.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              editable={step.kind === "code"}
              onSubmitEditing={() => code.trim() !== "" && void complete()}
              style={s.input}
            />
          </View>
        ) : null}

        {error === "" ? null : <Text style={s.danger}>{error}</Text>}

        <View style={[s.wrapRow, { justifyContent: "flex-end" }]}>
          <Button label={text.t("cancel")} kind="secondary" s={s} onPress={close} />
          {step.kind === "name" ? (
            <Button
              label={profile === null ? text.t("loginStart") : text.t("signInAgain")}
              s={s}
              disabled={(profile ?? id) === ""}
              onPress={() => void begin(profile ?? id)}
            />
          ) : null}
          {step.kind === "code" || step.kind === "finishing" ? (
            <Button
              label={step.kind === "finishing" ? text.t("loginFinishing") : text.t("loginFinish")}
              s={s}
              disabled={step.kind === "finishing" || code.trim() === ""}
              onPress={() => void complete()}
            />
          ) : null}
        </View>
      </Modal.Content>
    </Modal>
  );
}

export function RenameDialog({ id, onClose, onDone, s, text }: { id: string | null; onClose(): void; onDone(): void; s: Styles; text: Strings }) {
  const rename = useRpc(renameAccount);
  const toast = useToast();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(id ?? "");
    setError("");
  }, [id]);

  async function save() {
    if (id === null) return;
    setBusy(true);
    const result = await rename({ id, name: slug(name) ?? name }).catch((cause: unknown) => ({ ok: false as const, error: "io" as const, detail: String(cause) }));
    setBusy(false);
    if (!result.ok) return setError(text.error(result.error, result.detail));
    toast.show(text.t("renamed", { id: result.id }), { variant: "success" });
    onDone();
  }

  return (
    <Modal title={text.t("renameTitle", { id: id ?? "" })} open={id !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Modal.Content>
        <TextInput
          value={name}
          onChangeText={setName}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          onSubmitEditing={() => void save()}
          style={s.input}
        />
        <Text style={s.muted}>{text.t("loginNameHint", { id: slug(name) ?? "…" })}</Text>
        {error === "" ? null : <Text style={s.danger}>{error}</Text>}
        <View style={[s.wrapRow, { justifyContent: "flex-end" }]}>
          <Button label={text.t("cancel")} kind="secondary" s={s} onPress={onClose} />
          <Button label={text.t("renameSave")} s={s} disabled={busy || slug(name) === null || slug(name) === id} onPress={() => void save()} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

export function RemoveDialog({ id, onClose, onDone, s, text }: { id: string | null; onClose(): void; onDone(): void; s: Styles; text: Strings }) {
  const remove = useRpc(removeAccount);
  const toast = useToast();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => setError(""), [id]);

  async function confirm() {
    if (id === null) return;
    setBusy(true);
    const result = await remove({ id }).catch((cause: unknown) => ({ ok: false as const, error: "io" as const, detail: String(cause) }));
    setBusy(false);
    if (!result.ok) return setError(text.error(result.error, result.detail));
    toast.show(text.t("removed", { path: result.trash }), { variant: "success", durationMs: 4_000 });
    onDone();
  }

  return (
    <Modal title={text.t("removeTitle", { id: id ?? "" })} open={id !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Modal.Content>
        <Text style={s.body}>{text.t("removeBody", { trash: "~/.local/share/seamless-claude-accounts/trash" })}</Text>
        {error === "" ? null : <Text style={s.danger}>{error}</Text>}
        <View style={[s.wrapRow, { justifyContent: "flex-end" }]}>
          <Button label={text.t("cancel")} kind="secondary" s={s} onPress={onClose} />
          <Button label={text.t("removeConfirm")} kind="danger" s={s} disabled={busy} onPress={() => void confirm()} />
        </View>
      </Modal.Content>
    </Modal>
  );
}
