import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import { languages, preferences, type Preferences } from "../shared/contracts";
import { useStrings } from "./i18n";

const THRESHOLDS = [50, 60, 70, 75, 80, 85, 90, 95, 98, 100] as const;
const INTERVALS = [1, 2, 3, 5, 10, 15, 30] as const;

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const text = useStrings();
  const [prompt, setPrompt] = useState<string | null>(null);

  if (settings.status === "loading") return null;
  if (settings.status === "error" || settings.status === "invalid") {
    return (
      <SettingsSection title={text.t("settingsTitle")}>
        <SettingsCard>
          <SettingsAction label={text.t("saveFailed", { detail: settings.error })} actionLabel="Reset" onPress={() => void settings.reset()} />
        </SettingsCard>
      </SettingsSection>
    );
  }

  const values = settings.values;
  const save = (patch: Partial<Preferences>) => void settings.save({ ...values, ...patch }, settings.revision);
  const threshold = (value: number) => ({ label: value === 100 ? text.t("thresholdOff") : `${value}%`, value: String(value) });
  const draft = prompt ?? values.continuePrompt;

  return (
    <>
      <SettingsSection title={text.t("autoSection")}>
        <SettingsCard>
          <SettingsSwitch
            label={text.t("autoSwitchLabel")}
            hint={text.t("autoSwitchHint")}
            value={values.autoSwitch}
            onValueChange={(autoSwitch) => save({ autoSwitch })}
          />
          <SettingsSwitch
            label={text.t("autoContinueLabel")}
            hint={text.t("autoContinueHint")}
            value={values.autoContinue}
            disabled={!values.autoSwitch}
            onValueChange={(autoContinue) => save({ autoContinue })}
          />
          <SettingsInput
            label={text.t("continuePromptLabel")}
            initialValue={values.continuePrompt}
            placeholder="continue"
            disabled={!values.autoSwitch || !values.autoContinue}
            onChangeText={setPrompt}
          />
          {draft.trim() !== "" && draft !== values.continuePrompt ? (
            <SettingsAction
              label={text.t("continuePromptLabel")}
              hint={draft}
              actionLabel={text.t("renameSave")}
              onPress={() => {
                save({ continuePrompt: draft.trim().slice(0, 500) });
                setPrompt(null);
              }}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={text.t("preemptiveLabel")}>
        <SettingsCard>
          <SettingsSwitch
            label={text.t("preemptiveLabel")}
            hint={text.t("preemptiveHint")}
            value={values.preemptive}
            onValueChange={(preemptive) => save({ preemptive })}
          />
          <SettingsSelect
            label={text.t("sessionThresholdLabel")}
            value={String(values.sessionThreshold)}
            options={THRESHOLDS.map(threshold)}
            disabled={!values.preemptive}
            onValueChange={(value) => save({ sessionThreshold: Number(value) })}
          />
          <SettingsSelect
            label={text.t("weekThresholdLabel")}
            value={String(values.weekThreshold)}
            options={THRESHOLDS.map(threshold)}
            disabled={!values.preemptive}
            onValueChange={(value) => save({ weekThreshold: Number(value) })}
          />
          <SettingsSelect
            label={text.t("checkMinutesLabel")}
            value={String(values.checkMinutes)}
            options={INTERVALS.map((value) => ({ label: text.plural("minutes", value), value: String(value) }))}
            disabled={!values.preemptive}
            onValueChange={(value) => save({ checkMinutes: Number(value) })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={text.t("generalSection")}>
        <SettingsCard>
          <SettingsSelect
            label={text.t("languageLabel")}
            value={values.language}
            options={languages.map((value) => ({ label: value === "auto" ? text.t("languageAuto") : value === "es" ? "Español" : "English", value }))}
            onValueChange={(language) => save({ language })}
          />
        </SettingsCard>
      </SettingsSection>

      {settings.saveError ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{text.t("saveFailed", { detail: String(settings.saveError) })}</Text> : null}
    </>
  );
}
