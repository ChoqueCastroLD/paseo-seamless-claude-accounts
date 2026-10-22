import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const readSource = (path: string) => readFile(fileURLToPath(import.meta.resolve(path)), "utf8");

// The client module imports the Paseo runtime, so the dictionaries are read as source.
async function dictionaries(): Promise<Record<string, Map<string, string>>> {
  const source = await readSource("../client/i18n.ts");
  const read = (name: string) => {
    const start = source.indexOf(`const ${name}`);
    const body = source.slice(start, source.indexOf("\n};", start));
    return new Map(
      [...body.matchAll(/^\s+"?([\w-]+)"?: "((?:[^"\\]|\\.)*)",$/gm)].map((match) => [match[1]!, match[2]!]),
    );
  };
  return { en: read("en = {"), es: read("es: Record<Key, string> = {") };
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("translations", () => {
  it("cover the same keys with the same placeholders", async () => {
    const { en, es } = await dictionaries();
    assert.ok(en.size > 50);
    assert.deepEqual([...es.keys()].sort(), [...en.keys()].sort());
    for (const [key, text] of en) assert.deepEqual(placeholders(es.get(key)!), placeholders(text), key);
  });

  it("have a message for every server error code", async () => {
    const { en } = await dictionaries();
    const contracts = await readSource("../shared/contracts.ts");
    const block = contracts.slice(
      contracts.indexOf("export const errorCode"),
      contracts.indexOf("export type ErrorCode"),
    );
    for (const [, code] of block.matchAll(/"([a-z-]+)"/g)) assert.ok(en.has(`error-${code}`), code);
  });
});
