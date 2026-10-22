import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

const URL_TIMEOUT_MS = 20_000;
const EXCHANGE_TIMEOUT_MS = 60_000;
const SESSION_TTL_MS = 15 * 60_000;

const AUTHORIZE_URL = /https:\/\/\S+\/oauth\/authorize\?\S+/;

export class LoginError extends Error {
  readonly code: "claude-missing" | "login-failed" | "login-expired";

  constructor(code: "claude-missing" | "login-failed" | "login-expired", message: string) {
    super(message);
    this.code = code;
  }
}

interface Session {
  child: ChildProcessWithoutNullStreams;
  dir: string;
  output: string;
  exit: Promise<number | null>;
  timer: NodeJS.Timeout;
}

function tail(output: string): string {
  return output
    .replace(AUTHORIZE_URL, "")
    .replace(/paste code here if prompted\s*>/gi, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^(?:opening browser|if the browser)/i.test(line))
    .slice(-3)
    .join(" ")
    .slice(0, 300);
}

export class LoginFlow {
  #sessions = new Map<string, Session>();
  readonly #binary: string;
  readonly #args: string[];
  readonly #onAbandon: (dir: string) => void;

  constructor(options: { binary: string; args?: string[]; onAbandon?: (dir: string) => void }) {
    this.#binary = options.binary;
    this.#args = options.args ?? ["auth", "login", "--claudeai"];
    this.#onAbandon = options.onAbandon ?? (() => undefined);
  }

  async start(dir: string): Promise<{ session: string; url: string }> {
    const child = spawn(this.#binary, this.#args, {
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir, BROWSER: "true", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const id = randomUUID();
    const session: Session = {
      child,
      dir,
      output: "",
      exit: new Promise((resolve) => {
        child.once("exit", (code) => resolve(code));
        child.once("error", () => resolve(null));
      }),
      timer: setTimeout(() => {
        const dir = this.cancel(id);
        if (dir !== null) this.#onAbandon(dir);
      }, SESSION_TTL_MS),
    };
    session.timer.unref();
    const collect = (chunk: Buffer) => {
      session.output = (session.output + chunk.toString("utf8")).slice(-20_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const spawned = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      child.once("spawn", () => resolve(null));
      child.once("error", (error) => resolve(error));
    });
    if (spawned !== null) {
      clearTimeout(session.timer);
      throw new LoginError(spawned.code === "ENOENT" ? "claude-missing" : "login-failed", spawned.message);
    }

    const url = await new Promise<string | null>((resolve) => {
      const check = () => {
        const match = AUTHORIZE_URL.exec(session.output);
        if (match !== null) done(match[0]);
      };
      const done = (value: string | null) => {
        clearTimeout(timer);
        child.stdout.off("data", check);
        child.stderr.off("data", check);
        resolve(value);
      };
      const timer = setTimeout(() => done(null), URL_TIMEOUT_MS);
      child.stdout.on("data", check);
      child.stderr.on("data", check);
      void session.exit.then(() => done(AUTHORIZE_URL.exec(session.output)?.[0] ?? null));
      check();
    });
    if (url === null) {
      clearTimeout(session.timer);
      child.kill();
      throw new LoginError("login-failed", tail(session.output) || "claude did not print a sign-in link");
    }
    this.#sessions.set(id, session);
    return { session: id, url };
  }

  async finish(id: string, code: string): Promise<void> {
    const session = this.#sessions.get(id);
    if (session === undefined || session.child.exitCode !== null) {
      throw new LoginError("login-expired", "this sign-in is no longer waiting for a code");
    }
    this.#sessions.delete(id);
    clearTimeout(session.timer);
    // One line only: anything after the newline would be read as a second answer.
    session.child.stdin.end(`${code.trim().split(/\s+/)[0] ?? ""}\n`);
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), EXCHANGE_TIMEOUT_MS).unref(),
    );
    const status = await Promise.race([session.exit, timeout]);
    if (status === "timeout") {
      session.child.kill();
      throw new LoginError("login-failed", "claude did not finish the sign-in in time");
    }
    if (status !== 0) throw new LoginError("login-failed", tail(session.output) || `claude exited with ${status}`);
  }

  cancel(id: string): string | null {
    const session = this.#sessions.get(id);
    if (session === undefined) return null;
    this.#sessions.delete(id);
    clearTimeout(session.timer);
    session.child.kill();
    return session.dir;
  }

  dispose(): void {
    for (const id of [...this.#sessions.keys()]) this.cancel(id);
  }
}
