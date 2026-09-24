import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { platform } from "node:process";
import { extractCaddySiteUrls, extractHttpUrls, extractLocalPorts, extractPortForwards, resolveCaddyUrls } from "./discovery.js";
import { inspectProject, listDevspaceLogs, podLogs, tailDevspaceLog, type ProjectOverview } from "./observability.js";

const CONFIG_NAMES = ["devspace.yaml", "devspace.yml"] as const;
const MAX_LOG_LINES = 80;

export type DevSpaceState = "stopped" | "starting" | "running" | "stopping" | "failed" | "external";
export type DevSpaceStatus = {
  readonly detected: boolean;
  readonly directory: string;
  readonly configFile: string | null;
  readonly state: DevSpaceState;
  readonly pid: number | null;
  readonly links: readonly string[];
  readonly message: string | null;
  readonly logs: readonly string[];
};

type Session = {
  child: ChildProcess;
  state: Exclude<DevSpaceState, "stopped" | "external">;
  links: Set<string>;
  logs: string[];
  message: string | null;
};

export class DevSpaceManager {
  private readonly sessions = new Map<string, Session>();

  async status(directory: string): Promise<DevSpaceStatus> {
    const cwd = await projectDirectory(directory);
    const configFile = await findConfig(cwd);
    const session = this.sessions.get(cwd);
    if (session !== undefined && isAlive(session.child)) {
      if (session.state === "starting" && session.logs.length > 0) session.state = "running";
      await addPortLinks(cwd, session);
      const preferredLinks = await discoverCaddyLinks(cwd, configFile, session.logs);
      return snapshot(cwd, configFile, session, preferredLinks);
    }
    const external = await externalDevSpacePid(cwd);
    if (external !== null) return externalStatus(cwd, configFile, external);
    if (session !== undefined && session.state === "failed") {
      if (session.logs.some((line) => line.includes("another DevSpace session for the project"))) {
        return externalStatus(cwd, configFile, null, "Outra sessao DevSpace ocupa este projeto/namespace. Atualize antes de tentar novamente.");
      }
      return snapshot(cwd, configFile, session);
    }
    this.sessions.delete(cwd);
    return idle(cwd, configFile);
  }

  async start(directory: string): Promise<DevSpaceStatus> {
    const cwd = await projectDirectory(directory);
    const configFile = await findConfig(cwd);
    if (configFile === null) return idle(cwd, null, "Nenhum devspace.yaml ou devspace.yml encontrado neste projeto.");
    const current = this.sessions.get(cwd);
    if (current !== undefined && isAlive(current.child)) return snapshot(cwd, configFile, current);
    const external = await externalDevSpacePid(cwd);
    if (external !== null) return externalStatus(cwd, configFile, external);

    const child = spawn("devspace", ["dev", "--no-colors"], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const session: Session = { child, state: "starting", links: new Set(), logs: [], message: "DevSpace está iniciando." };
    this.sessions.set(cwd, session);
    collectOutput(child.stdout, session);
    collectOutput(child.stderr, session);
    child.once("spawn", () => { session.message = "DevSpace iniciou; aguardando serviços e port forwards."; });
    child.once("error", (error) => {
      session.state = "failed";
      session.message = `Falha ao iniciar DevSpace: ${error.message}`;
      appendLog(session, error.message);
    });
    child.once("exit", (code, signal) => {
      if (session.state === "stopping" || code === 0) {
        this.sessions.delete(cwd);
        return;
      }
      session.state = "failed";
      session.message = `DevSpace encerrou com ${signal === null ? `código ${code ?? "desconhecido"}` : `sinal ${signal}`}.`;
    });
    return snapshot(cwd, configFile, session);
  }

  async stop(directory: string): Promise<DevSpaceStatus> {
    const cwd = await projectDirectory(directory);
    const configFile = await findConfig(cwd);
    const session = this.sessions.get(cwd);
    if (session === undefined || !isAlive(session.child)) {
      this.sessions.delete(cwd);
      const external = await externalDevSpacePid(cwd);
      return external !== null ? externalStatus(cwd, configFile, external) : idle(cwd, configFile, "DevSpace já está parado.");
    }
    session.state = "stopping";
    session.message = "Parando DevSpace e port forwards...";
    session.child.kill("SIGINT");
    const stopped = await waitForExit(session.child, 8_000);
    if (!stopped) session.child.kill("SIGTERM");
    if (!stopped && !(await waitForExit(session.child, 3_000))) {
      session.state = "failed";
      session.message = "DevSpace não respondeu a SIGINT ou SIGTERM; verifique o processo manualmente.";
      return snapshot(cwd, configFile, session);
    }
    this.sessions.delete(cwd);
    return idle(cwd, configFile, "DevSpace parado.");
  }

  async restart(directory: string): Promise<DevSpaceStatus> {
    const stopped = await this.stop(directory);
    if (stopped.state === "external" || stopped.state === "failed") return stopped;
    return this.start(directory);
  }

  async openUrl(value: string): Promise<string> {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new InvalidUrlError(value);
    const [command, args] = openCommand(url.toString());
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    return url.toString();
  }

  async inspect(directory: string): Promise<ProjectOverview> {
    const status = await this.status(directory);
    if (!status.detected) throw new Error("Projeto sem configuracao DevSpace.");
    return inspectProject(status.directory, status.pid);
  }

  async podLogs(overview: ProjectOverview, podName: string, containerName: string): Promise<string[]> {
    return podLogs(overview, podName, containerName);
  }

  async devspaceLogFiles(directory: string): Promise<string[]> {
    return listDevspaceLogs(await projectDirectory(directory));
  }

  async devspaceLogs(directory: string, filename: string): Promise<string[]> {
    return tailDevspaceLog(await projectDirectory(directory), filename);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((directory) => this.stop(directory)));
  }
}

class InvalidUrlError extends Error {
  override readonly name = "InvalidUrlError";
  constructor(value: string) { super(`Somente URLs HTTP ou HTTPS podem ser abertas: ${value}`); }
}

async function projectDirectory(directory: string): Promise<string> {
  const cwd = resolve(directory);
  const metadata = await stat(cwd);
  if (!metadata.isDirectory()) throw new NotDirectoryError(cwd);
  return cwd;
}

class NotDirectoryError extends Error {
  override readonly name = "NotDirectoryError";
  constructor(directory: string) { super(`Diretório de projeto inválido: ${directory}`); }
}

async function findConfig(directory: string): Promise<string | null> {
  for (const name of CONFIG_NAMES) {
    try {
      await access(join(directory, name));
      return name;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  return null;
}

function collectOutput(stream: NodeJS.ReadableStream | null, session: Session): void {
  if (stream === null) return;
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/u).filter(Boolean)) appendLog(session, line);
    for (const url of extractHttpUrls(chunk)) session.links.add(url);
  });
}

function appendLog(session: Session, line: string): void {
  session.logs.push(line.replace(/\u001b\[[0-9;]*m/gu, ""));
  if (session.logs.length > MAX_LOG_LINES) session.logs.splice(0, session.logs.length - MAX_LOG_LINES);
}

async function addPortLinks(directory: string, session: Session): Promise<void> {
  const stdout = await execDevSpacePorts(directory);
  if (stdout === null) return;
  const value: unknown = JSON.parse(stdout);
  for (const port of extractLocalPorts(value)) session.links.add(`http://localhost:${port}`);
}

function execDevSpacePorts(directory: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile("devspace", ["list", "ports", "--output", "json", "--no-colors"], { cwd: directory, timeout: 3_000, maxBuffer: 512_000 }, (error, stdout) => {
      resolvePromise(error === null ? stdout : null);
    });
  });
}

async function discoverCaddyLinks(directory: string, configFile: string | null, logs: readonly string[]): Promise<readonly string[]> {
  if (configFile === null) return [];
  try {
    const [caddyfile, config] = await Promise.all([readFile(join(directory, "Caddyfile"), "utf8"), readFile(join(directory, configFile), "utf8")]);
    return resolveCaddyUrls(extractCaddySiteUrls(caddyfile), extractPortForwards(`${config}\n${logs.join("\n")}`));
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

function snapshot(directory: string, configFile: string | null, session: Session, preferredLinks: readonly string[] = []): DevSpaceStatus {
  return { detected: configFile !== null, directory, configFile, state: session.state, pid: session.child.pid ?? null, links: preferredLinks.length > 0 ? preferredLinks : [...session.links].sort(), message: session.message, logs: session.logs.slice(-20) };
}

function idle(directory: string, configFile: string | null, message: string | null = null): DevSpaceStatus {
  return { detected: configFile !== null, directory, configFile, state: "stopped", pid: null, links: [], message, logs: [] };
}

function externalStatus(directory: string, configFile: string | null, pid: number | null, reason?: string): DevSpaceStatus {
  return {
    detected: configFile !== null,
    directory,
    configFile,
    state: "external",
    pid,
    links: [],
    message: reason ?? "Sessao DevSpace existente (fora deste plugin). Use o terminal que a iniciou para ver logs ou encerra-la.",
    logs: [],
  };
}

async function externalDevSpacePid(directory: string): Promise<number | null> {
  if (process.platform !== "linux") return null;
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch (error) {
    if (isUnavailableProcess(error)) return null;
    throw error;
  }
  const target = await realpath(directory);
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
      const isDev = (args[1] === "dev" && args[0] !== undefined && resolve(args[0]).endsWith("/devspace"))
        || /^devspace dev(?:\s|$)/u.test(args[0] ?? "");
      if (isDev && await readlink(`/proc/${pid}/cwd`) === target) return pid;
    } catch (error) {
      if (!isUnavailableProcess(error)) throw error;
    }
  }
  return null;
}

function isUnavailableProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM" || error.code === "ESRCH");
}

function isAlive(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isAlive(child)) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolvePromise(true); });
  });
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function openCommand(url: string): readonly [string, readonly string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}
