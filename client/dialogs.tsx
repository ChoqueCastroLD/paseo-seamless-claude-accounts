import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { copyText, Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import {
  cancelLogin,
  finishLogin,
  removeAccount,
  renameAccount,
  startLogin,
  type ErrorCode,
} from "../shared/contracts";
import { slug } from "../shared/names";
import type { Strings } from "./i18n";
import type { Styles } from "./styles";

interface Failure {
  ok: false;
  error: ErrorCode;
  detail: string;
}

function transportFailure(cause: unknown): Failure {
  return { ok: false, error: "io", detail: String(cause) };
}

interface ButtonProps {
  label: string;
  onPress(): void;
  s: Styles;
  kind?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  icon?: string;
}

function Button({ label, onPress, s, kind = "primary", disabled = false, icon }: ButtonProps) {
  const style = kind === "primary" ? s.primary : kind === "danger" ? s.dangerButton : s.secondary;
  const textStyle = kind === "secondary" ? s.secondaryText : s.primaryText;
  const color = kind === "secondary" ? s.colors.foreground : s.colors.accentForeground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[style, s.compact ? null : { minWidth: 96 }, disabled ? s.disabled : null]}
    >
      {icon === undefined ? null : <Icon name={icon} size={16} color={color} />}
      <Text style={textStyle}>{label}</Text>
    </Pressable>
  );
}

function Field({ label, hint, s, children }: { label: string; hint?: string; s: Styles; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={[s.body, { fontWeight: "600" }]}>{label}</Text>
      {children}
      {hint === undefined ? null : <Text style={s.muted}>{hint}</Text>}
    </View>
  );
}

type LoginStep =
  | { kind: "name" }
  | { kind: "starting" }
  | { kind: "code"; session: string; url: string }
  | { kind: "finishing"; session: string; url: string };

interface LoginDialogProps {
  profile: string | null;
  onClose(): void;
  onDone(): void;
  s: Styles;
  text: Strings;
}

export function LoginDialog({ profile, onClose, onDone, s, text }: LoginDialogProps) {
  const start = useRpc(startLogin);
  const finish = useRpc(finishLogin);
  const cancel = useRpc(cancelLogin);
  const toast = useToast();
  const [name, setName] = useState(profile ?? "");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [step, setStep] = useState<LoginStep>(profile === null ? { kind: "name" } : { kind: "starting" });
  const session = useRef<string | null>(null);
  const autoStarted = useRef(false);

  async function request(target: string) {
    const result = await start({ name: target }).catch(transportFailure);
    if (!result.ok) {
      setError(text.error(result.error, result.detail));
      setStep({ kind: "name" });
      return;
    }
    session.current = result.session;
    setStep({ kind: "code", session: result.session, url: result.url });
  }

  useEffect(() => {
    if (profile === null || autoStarted.current) return;
    autoStarted.current = true;
    void request(profile);
  });

  function begin(target: string) {
    setError("");
    setStep({ kind: "starting" });
    void request(target);
  }

  async function complete() {
    if (step.kind !== "code") return;
    setError("");
    setStep({ ...step, kind: "finishing" });
    const result = await finish({ session: step.session, code }).catch(transportFailure);
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

  const id = profile ?? slug(name) ?? "";
  const awaitingCode = step.kind === "code" || step.kind === "finishing";

  return (
    <Modal
      title={profile === null ? text.t("loginTitle") : text.t("reloginTitle", { id: profile })}
      icon={<Icon name="UserPlus" size={18} color={s.colors.foreground} />}
      open
      onOpenChange={(open) => (open ? undefined : close())}
    >
      <Modal.Content>
        {step.kind === "name" && profile === null ? (
          <Field label={text.t("loginName")} hint={text.t("loginNameHint", { id: id || "…" })} s={s}>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="work"
              placeholderTextColor={s.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              returnKeyType="next"
              onSubmitEditing={() => (id === "" ? undefined : begin(id))}
              style={s.input}
            />
          </Field>
        ) : null}

        {step.kind === "starting" ? <Text style={s.muted}>{text.t("loginStarting")}</Text> : null}

        {awaitingCode ? (
          <View style={{ gap: 16 }}>
            <View style={{ gap: 8 }}>
              <Text style={s.body}>{text.t("loginStep1")}</Text>
              <View style={s.compact ? { gap: 8 } : s.wrapRow}>
                <Button
                  label={text.t("loginOpen")}
                  icon="ExternalLink"
                  s={s}
                  onPress={() => void openExternalUrl(step.url).catch(() => toast.error(step.url))}
                />
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
            </View>
            <Field label={text.t("loginStep2")} s={s}>
              <TextInput
                value={code}
                onChangeText={setCode}
                placeholder={text.t("loginCode")}
                placeholderTextColor={s.colors.foregroundMuted}
                autoCapitalize="none"
                autoCorrect={false}
                editable={step.kind === "code"}
                returnKeyType="done"
                onSubmitEditing={() => (code.trim() === "" ? undefined : void complete())}
                style={s.input}
              />
            </Field>
          </View>
        ) : null}

        {error === "" ? null : <Text style={s.danger}>{error}</Text>}

        <View style={s.dialogActions}>
          <Button label={text.t("cancel")} kind="secondary" s={s} onPress={close} />
          {step.kind === "name" ? (
            <Button
              label={profile === null ? text.t("loginStart") : text.t("signInAgain")}
              s={s}
              disabled={id === ""}
              onPress={() => begin(id)}
            />
          ) : null}
          {awaitingCode ? (
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

interface ProfileDialogProps {
  id: string;
  onClose(): void;
  onDone(): void;
  s: Styles;
  text: Strings;
}

export function RenameDialog({ id, onClose, onDone, s, text }: ProfileDialogProps) {
  const rename = useRpc(renameAccount);
  const toast = useToast();
  const [name, setName] = useState(id);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const next = slug(name);

  async function save() {
    if (next === null || next === id) return;
    setBusy(true);
    const result = await rename({ id, name: next }).catch(transportFailure);
    setBusy(false);
    if (!result.ok) return setError(text.error(result.error, result.detail));
    toast.show(text.t("renamed", { id: result.id }), { variant: "success" });
    onDone();
  }

  return (
    <Modal title={text.t("renameTitle", { id })} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Field label={text.t("loginName")} hint={text.t("loginNameHint", { id: next ?? "…" })} s={s}>
          <TextInput
            value={name}
            onChangeText={setName}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={() => void save()}
            style={s.input}
          />
        </Field>
        {error === "" ? null : <Text style={s.danger}>{error}</Text>}
        <View style={s.dialogActions}>
          <Button label={text.t("cancel")} kind="secondary" s={s} onPress={onClose} />
          <Button
            label={text.t("renameSave")}
            s={s}
            disabled={busy || next === null || next === id}
            onPress={() => void save()}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

export function RemoveDialog({ id, onClose, onDone, s, text }: ProfileDialogProps) {
  const remove = useRpc(removeAccount);
  const toast = useToast();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    const result = await remove({ id }).catch(transportFailure);
    setBusy(false);
    if (!result.ok) return setError(text.error(result.error, result.detail));
    toast.show(text.t("removed", { path: result.trash }), { variant: "success", durationMs: 4_000 });
    onDone();
  }

  return (
    <Modal title={text.t("removeTitle", { id })} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Text style={s.body}>{text.t("removeBody", { trash: "~/.local/share/seamless-claude-accounts/trash" })}</Text>
        {error === "" ? null : <Text style={s.danger}>{error}</Text>}
        <View style={s.dialogActions}>
          <Button label={text.t("cancel")} kind="secondary" s={s} onPress={onClose} />
          <Button
            label={text.t("removeConfirm")}
            kind="danger"
            icon="Trash2"
            s={s}
            disabled={busy}
            onPress={() => void confirm()}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}
