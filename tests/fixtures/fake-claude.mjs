// Stands in for `claude auth login`: prints a sign-in link, reads one code line, and stores a
// login in CLAUDE_CONFIG_DIR the way the real CLI does. The code picks the outcome:
// "good-<email>" signs in as that address, anything else fails like a rejected code.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const dir = process.env.CLAUDE_CONFIG_DIR;
process.stdout.write("Opening browser to sign in…\n");
process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=test\n");
process.stdout.write("Paste code here if prompted > ");

const lines = createInterface({ input: process.stdin });
lines.once("line", (code) => {
  const match = /^good-(.+)$/.exec(code.trim());
  if (match === null) {
    process.stdout.write("Login failed: Request failed with status code 400\n");
    process.exit(1);
  }
  const email = match[1];
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: `at-${email}`, refreshToken: `rt-${email}`, expiresAt: Date.now() + 3_600_000 } }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: `uuid-${email}`, organizationUuid: "org" } }),
  );
  process.stdout.write("Login successful.\n");
  process.exit(0);
});
