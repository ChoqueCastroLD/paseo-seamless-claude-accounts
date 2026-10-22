import { useSettings } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { preferences, type ErrorCode } from "../shared/contracts";

/**
 * English and Spanish strings. Paseo 0.12 has no translation API for plugins yet, so the
 * language follows the plugin setting, and "auto" follows the device.
 */
const en = {
  title: "Claude accounts",
  sidebar: "Claude accounts",
  commandOpen: "Switch Claude account",
  commandSettings: "Claude account settings",
  slashDescription: "Switch the active Claude account",
  slashHint: "[account]",
  intro: "Switching rewrites the live login the way `claude login` does. Open chats keep their history and use the new account from their next message.",
  use: "Use",
  switching: "Switching…",
  active: "Active",
  refresh: "Refresh usage",
  addAccount: "Add account",
  loading: "Reading accounts…",
  empty: "No Claude login found on this machine yet. Add one to get started.",
  loadFailed: "Could not read the accounts: {detail}",
  unidentified: "Unidentified account",
  session: "5 h",
  week: "7 days",
  noReading: "no reading yet",
  resetsIn: "resets {time}",
  readingAge: "read {time}",
  exhausted: "Used up until {time}",
  statusNoLogin: "Sign-in not finished",
  statusRelogin: "Sign-in expired",
  loginExpiresSoon: "Sign-in expires {time}",
  signIn: "Sign in",
  signInAgain: "Sign in again",
  rename: "Rename",
  remove: "Remove",
  nowUsing: "Now using {email}",
  renamed: "Renamed to {id}",
  removed: "Moved to {path}",
  autoOn: "Auto-switch on",
  autoOff: "Auto-switch off",
  autoSummary: "Switches when a chat hits its limit{threshold}, then {resume}.",
  autoThreshold: ", or earlier at {session}% of 5 h or {week}% of 7 days",
  autoResume: "resumes it",
  autoNoResume: "leaves it for you to resume",
  history: "Recent switches",
  historyEntry: "{from} → {to}",
  reasonManual: "manual",
  reasonLimit: "limit reached",
  reasonThreshold: "threshold",
  resumedChats_one: "{count} chat resumed",
  resumedChats_other: "{count} chats resumed",
  // Login
  loginTitle: "Add a Claude account",
  reloginTitle: "Sign in to {id} again",
  loginName: "Profile name",
  loginNameHint: "Saved as ~/.claude-{id}. Letters, numbers and dashes.",
  loginStart: "Get sign-in link",
  loginStarting: "Starting claude…",
  loginStep1: "1. Open the link and sign in with the account you want to add.",
  loginStep2: "2. Paste the code the page shows.",
  loginOpen: "Open sign-in page",
  loginCopy: "Copy link",
  loginCopied: "Link copied",
  loginCode: "Code",
  loginFinish: "Add account",
  loginFinishing: "Signing in…",
  loginDone: "Added {email}",
  cancel: "Cancel",
  // Rename and remove
  renameTitle: "Rename {id}",
  renameSave: "Save",
  removeTitle: "Remove {id}?",
  removeBody: "The profile moves to {trash}. Nothing is deleted and no other account changes. Sign in again later to bring it back.",
  removeConfirm: "Remove",
  // Timeline
  rowSwitched: "Account limit reached. Switched from {from} to {to}.",
  rowSwitchedThreshold: "Switched from {from} to {to} before the limit.",
  rowExhausted: "Every Claude account is out of allowance.",
  rowNextReset: "The first one frees up {time}.",
  // Slash command
  slashActive: "Active account: {email}. Use /account <name> to switch.",
  slashUnknown: "No account matches \"{name}\".",
  // Settings
  settingsTitle: "Claude accounts",
  autoSection: "Automatic switching",
  autoSwitchLabel: "Switch when a chat hits its limit",
  autoSwitchHint: "Moves every chat to the account with the most allowance left.",
  autoContinueLabel: "Resume the chats that stopped",
  autoContinueHint: "Sends the prompt below to each chat that stopped at the limit.",
  continuePromptLabel: "Resume prompt",
  preemptiveLabel: "Switch before the limit",
  preemptiveHint: "Switches as soon as either window reaches its threshold, whichever comes first.",
  sessionThresholdLabel: "5-hour window threshold",
  weekThresholdLabel: "7-day window threshold",
  thresholdOff: "Only at the limit",
  checkMinutesLabel: "Check usage every",
  minutes_one: "{count} minute",
  minutes_other: "{count} minutes",
  generalSection: "General",
  languageLabel: "Language",
  languageAuto: "Device language",
  saveFailed: "Could not save: {detail}",
  // Relative time
  now: "now",
  inMinutes: "in {count} min",
  inHours: "in {count} h",
  inDays: "in {count} d",
  minutesAgo: "{count} min ago",
  hoursAgo: "{count} h ago",
  daysAgo: "{count} d ago",
  // Errors
  "error-unknown-account": "That account no longer exists.",
  "error-no-login": "This profile has no finished sign-in.",
  "error-invalid-login": "The stored sign-in is not usable: {detail}",
  "error-invalid-name": "Use letters, numbers and dashes, starting with a letter or number.",
  "error-name-taken": "Another profile already has that name.",
  "error-active-account": "That is the account in use. Switch to another one first.",
  "error-login-expired": "This sign-in timed out. Start again.",
  "error-login-failed": "Sign-in failed: {detail}",
  "error-login-duplicate": "That account is already saved as {detail}.",
  "error-claude-missing": "The claude CLI was not found on the daemon machine.",
  "error-io": "Something went wrong: {detail}",
};

export type Key = keyof typeof en;

const es: Record<Key, string> = {
  title: "Cuentas de Claude",
  sidebar: "Cuentas de Claude",
  commandOpen: "Cambiar de cuenta de Claude",
  commandSettings: "Ajustes de cuentas de Claude",
  slashDescription: "Cambia la cuenta de Claude activa",
  slashHint: "[cuenta]",
  intro: "Cambiar reescribe el login activo igual que `claude login`. Los chats abiertos conservan su historial y usan la cuenta nueva desde su siguiente mensaje.",
  use: "Usar",
  switching: "Cambiando…",
  active: "Activa",
  refresh: "Actualizar consumo",
  addAccount: "Añadir cuenta",
  loading: "Leyendo cuentas…",
  empty: "Todavía no hay ningún login de Claude en esta máquina. Añade uno para empezar.",
  loadFailed: "No se pudieron leer las cuentas: {detail}",
  unidentified: "Cuenta sin identificar",
  session: "5 h",
  week: "7 días",
  noReading: "sin lectura",
  resetsIn: "se reinicia {time}",
  readingAge: "leído {time}",
  exhausted: "Agotada hasta {time}",
  statusNoLogin: "Inicio de sesión sin terminar",
  statusRelogin: "Sesión caducada",
  loginExpiresSoon: "La sesión caduca {time}",
  signIn: "Iniciar sesión",
  signInAgain: "Volver a iniciar sesión",
  rename: "Renombrar",
  remove: "Quitar",
  nowUsing: "Ahora: {email}",
  renamed: "Renombrada a {id}",
  removed: "Movida a {path}",
  autoOn: "Cambio automático activo",
  autoOff: "Cambio automático apagado",
  autoSummary: "Cambia cuando un chat agota su límite{threshold} y {resume}.",
  autoThreshold: ", o antes al {session}% de 5 h o al {week}% de 7 días",
  autoResume: "lo reanuda",
  autoNoResume: "te deja reanudarlo",
  history: "Cambios recientes",
  historyEntry: "{from} → {to}",
  reasonManual: "manual",
  reasonLimit: "límite alcanzado",
  reasonThreshold: "umbral",
  resumedChats_one: "{count} chat reanudado",
  resumedChats_other: "{count} chats reanudados",
  loginTitle: "Añadir una cuenta de Claude",
  reloginTitle: "Volver a iniciar sesión en {id}",
  loginName: "Nombre del perfil",
  loginNameHint: "Se guarda como ~/.claude-{id}. Letras, números y guiones.",
  loginStart: "Obtener enlace",
  loginStarting: "Iniciando claude…",
  loginStep1: "1. Abre el enlace e inicia sesión con la cuenta que quieres añadir.",
  loginStep2: "2. Pega el código que muestra la página.",
  loginOpen: "Abrir página de inicio de sesión",
  loginCopy: "Copiar enlace",
  loginCopied: "Enlace copiado",
  loginCode: "Código",
  loginFinish: "Añadir cuenta",
  loginFinishing: "Iniciando sesión…",
  loginDone: "Añadida {email}",
  cancel: "Cancelar",
  renameTitle: "Renombrar {id}",
  renameSave: "Guardar",
  removeTitle: "¿Quitar {id}?",
  removeBody: "El perfil se mueve a {trash}. No se borra nada ni cambia ninguna otra cuenta. Vuelve a iniciar sesión para recuperarla.",
  removeConfirm: "Quitar",
  rowSwitched: "Límite de la cuenta alcanzado. Cambiado de {from} a {to}.",
  rowSwitchedThreshold: "Cambiado de {from} a {to} antes del límite.",
  rowExhausted: "Todas las cuentas de Claude están agotadas.",
  rowNextReset: "La primera se libera {time}.",
  slashActive: "Cuenta activa: {email}. Usa /account <nombre> para cambiar.",
  slashUnknown: "Ninguna cuenta coincide con \"{name}\".",
  settingsTitle: "Cuentas de Claude",
  autoSection: "Cambio automático",
  autoSwitchLabel: "Cambiar cuando un chat agote su límite",
  autoSwitchHint: "Pasa todos los chats a la cuenta con más margen.",
  autoContinueLabel: "Reanudar los chats que se pararon",
  autoContinueHint: "Envía el mensaje de abajo a cada chat que se paró en el límite.",
  continuePromptLabel: "Mensaje para reanudar",
  preemptiveLabel: "Cambiar antes del límite",
  preemptiveHint: "Cambia en cuanto cualquiera de las dos ventanas llega a su umbral, lo que pase primero.",
  sessionThresholdLabel: "Umbral de la ventana de 5 horas",
  weekThresholdLabel: "Umbral de la ventana de 7 días",
  thresholdOff: "Solo al llegar al límite",
  checkMinutesLabel: "Comprobar el consumo cada",
  minutes_one: "{count} minuto",
  minutes_other: "{count} minutos",
  generalSection: "General",
  languageLabel: "Idioma",
  languageAuto: "Idioma del dispositivo",
  saveFailed: "No se pudo guardar: {detail}",
  now: "ahora",
  inMinutes: "en {count} min",
  inHours: "en {count} h",
  inDays: "en {count} d",
  minutesAgo: "hace {count} min",
  hoursAgo: "hace {count} h",
  daysAgo: "hace {count} d",
  "error-unknown-account": "Esa cuenta ya no existe.",
  "error-no-login": "Este perfil no tiene un inicio de sesión terminado.",
  "error-invalid-login": "El login guardado no sirve: {detail}",
  "error-invalid-name": "Usa letras, números y guiones, empezando por letra o número.",
  "error-name-taken": "Ya hay otro perfil con ese nombre.",
  "error-active-account": "Es la cuenta en uso. Cambia a otra primero.",
  "error-login-expired": "Este inicio de sesión caducó. Empieza de nuevo.",
  "error-login-failed": "Falló el inicio de sesión: {detail}",
  "error-login-duplicate": "Esa cuenta ya está guardada como {detail}.",
  "error-claude-missing": "No se encontró el CLI claude en la máquina del daemon.",
  "error-io": "Algo falló: {detail}",
};

const dictionaries = { en, es } as const;
export type Language = keyof typeof dictionaries;
type Values = Record<string, string | number>;

export interface Strings {
  language: Language;
  t(key: Key, values?: Values): string;
  /** A count-dependent string: `minutes` picks `minutes_one` or `minutes_other`. */
  plural(base: "minutes" | "resumedChats", count: number): string;
  error(code: ErrorCode, detail: string): string;
  /** "in 2 h", "5 min ago". */
  relative(iso: string, now?: number): string;
}

export function deviceLanguage(): Language {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("es") ? "es" : "en";
  } catch {
    return "en";
  }
}

export function strings(language: Language): Strings {
  const dictionary = dictionaries[language];
  const t = (key: Key, values: Values = {}) =>
    dictionary[key].replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
  return {
    language,
    t,
    plural: (base, count) => t(`${base}_${count === 1 ? "one" : "other"}` as Key, { count }),
    error: (code, detail) => t(`error-${code}` as Key, { detail }),
    relative(iso, now = Date.now()) {
      const delta = Date.parse(iso) - now;
      const minutes = Math.round(Math.abs(delta) / 60_000);
      if (minutes < 1) return t("now");
      const future = delta > 0;
      if (minutes < 60) return t(future ? "inMinutes" : "minutesAgo", { count: minutes });
      const hours = Math.round(minutes / 60);
      if (hours < 48) return t(future ? "inHours" : "hoursAgo", { count: hours });
      return t(future ? "inDays" : "daysAgo", { count: Math.round(hours / 24) });
    },
  };
}

/** Strings in the language the plugin setting asks for. */
export function useStrings(): Strings {
  const settings = useSettings(preferences);
  const choice = settings.status === "ready" ? settings.values.language : "auto";
  return useMemo(() => strings(choice === "auto" ? deviceLanguage() : choice), [choice]);
}
