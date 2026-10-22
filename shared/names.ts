/** What a profile may be called. The directory is `~/.claude-<name>`. */
export const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** Turns free text into a profile name, or null when nothing usable is left. */
export function slug(text: string): string | null {
  const value = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 48);
  return PROFILE_NAME.test(value) ? value : null;
}
