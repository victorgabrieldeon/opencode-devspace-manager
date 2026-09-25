import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listEnvironment, updateEnvironment } from "../src/environment.js";

test("edits only the selected env, masks values, and refuses a stale file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-env-"));
  const path = join(directory, ".env");
  await writeFile(path, "# keep this comment\nAPI_PORT=3000\nAPI_INTERNAL_TOKEN=old-secret\n");
  await chmod(path, 0o600);
  await writeFile(join(directory, ".env.example"), "API_PORT=3000\nAPI_INTERNAL_TOKEN=\nNEW_KEY=\n");
  const initial = await listEnvironment(directory);
  expect(initial.entries).toEqual([
    { name: "API_PORT", set: true, sensitive: false, source: "local" },
    { name: "API_INTERNAL_TOKEN", set: true, sensitive: true, source: "local" },
    { name: "NEW_KEY", set: false, sensitive: false, source: "example" },
  ]);
  expect(JSON.stringify(initial)).not.toContain("old-secret");
  const next = await updateEnvironment(directory, "API_INTERNAL_TOKEN", "new secret#value", initial.revision);
  expect(await readFile(path, "utf8")).toBe("# keep this comment\nAPI_PORT=3000\nAPI_INTERNAL_TOKEN=new secret#value\n");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await expect(updateEnvironment(directory, "API_PORT", "4000", initial.revision)).rejects.toThrow("mudou desde a leitura");
  await updateEnvironment(directory, "NEW_KEY", "ok", next.revision);
  expect((await readFile(path, "utf8")).endsWith("NEW_KEY=ok\n")).toBe(true);
  await expect(updateEnvironment(directory, "NEW_KEY", "bad\nvalue", (await listEnvironment(directory)).revision)).rejects.toThrow("unica linha");
});
