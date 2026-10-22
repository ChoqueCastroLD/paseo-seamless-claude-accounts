export const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;

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
