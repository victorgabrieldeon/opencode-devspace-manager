import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u;
const SENSITIVE = /(?:TOKEN|SECRET|PASSWORD|PASS|PRIVATE|API_KEY|ACCESS_KEY|CREDENTIAL|AUTH|DATABASE_URL|DSN)/iu;

export type EnvEntry = { name: string; set: boolean; sensitive: boolean; source: "local" | "example" };
export type EnvSnapshot = { path: string; revision: string; entries: readonly EnvEntry[] };

function revision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function assignments(content: string): Map<string, { index: number; value: string }> {
  const result = new Map<string, { index: number; value: string }>();
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    const match = line.match(ASSIGNMENT);
    if (!match?.[1]) continue;
    if (result.has(match[1])) throw new Error(`Variavel duplicada em .env: ${match[1]}. Corrija no arquivo antes de editar pela TUI.`);
    result.set(match[1], { index, value: line.slice(match[0].length) });
  }
  return result;
}

async function localFile(directory: string): Promise<{ path: string; content: string; mode: number }> {
  const path = join(directory, ".env");
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(".env precisa ser um arquivo regular, sem symlink.");
  return { path, content: await readFile(path, "utf8"), mode: info.mode & 0o777 };
}

export async function listEnvironment(directory: string): Promise<EnvSnapshot> {
  const file = await localFile(directory);
  const local = assignments(file.content);
  let template = new Map<string, { index: number; value: string }>();
  try { template = assignments(await readFile(join(directory, ".env.example"), "utf8")); }
  catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
  }
  const names = [...local.keys(), ...[...template.keys()].filter((name) => !local.has(name))];
  return {
    path: file.path,
    revision: revision(file.content),
    entries: names.map((name) => {
      const item = local.get(name);
      return { name, set: !!item?.value.trim(), sensitive: SENSITIVE.test(name)
        || /:\/\/[^\s/@]+:[^\s/@]+@/u.test(item?.value ?? ""), source: item ? "local" : "example" };
    }),
  };
}

function encodeValue(value: string): string {
  if (value.length > 8192 || /[\r\n\0-\x1f\x7f]/u.test(value)) throw new Error("Valor invalido: use uma unica linha com ate 8192 caracteres.");
  if (/\s#/u.test(value)) throw new Error("Valor ambiguo em .env: remova o espaco antes de #.");
  return value;
}

export async function updateEnvironment(directory: string, name: string, value: string, expectedRevision: string): Promise<EnvSnapshot> {
  if (!NAME.test(name)) throw new Error("Nome de variavel invalido.");
  const file = await localFile(directory);
  if (revision(file.content) !== expectedRevision) throw new Error(".env mudou desde a leitura. Atualize a tela antes de salvar.");
  const local = assignments(file.content);
  const allowed = local.has(name) || (await listEnvironment(directory)).entries.some((entry) => entry.name === name);
  if (!allowed) throw new Error("Variavel ausente do .env e do .env.example.");
  const encoded = encodeValue(value);
  const ending = file.content.includes("\r\n") ? "\r\n" : "\n";
  const lines = file.content.split(/\r?\n/u);
  const current = local.get(name);
  if (current) {
    const prefix = lines[current.index]?.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*/u)?.[0];
    if (prefix === undefined) throw new Error("Atribuicao .env nao reconhecida.");
    lines[current.index] = `${prefix}${encoded}`;
  } else {
    if (lines.at(-1) === "") lines.pop();
    lines.push(`${name}=${encoded}`);
    if (file.content.endsWith("\n")) lines.push("");
  }
  const next = lines.join(ending);
  const temporary = join(directory, `.env.${randomBytes(8).toString("hex")}.tmp`);
  try {
    const handle = await open(temporary, "wx", file.mode);
    try { await handle.writeFile(next); await handle.sync(); }
    finally { await handle.close(); }
    await chmod(temporary, file.mode);
    // Detect edits made while writing the temporary file, before replacing .env.
    if (revision((await localFile(directory)).content) !== expectedRevision) throw new Error(".env mudou durante a gravacao. Nada foi substituido.");
    await rename(temporary, file.path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return listEnvironment(directory);
}
