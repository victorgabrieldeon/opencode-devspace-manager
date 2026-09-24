import { execFile } from "node:child_process";
import { open, readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { extractCaddySiteUrls, resolveCaddyUrls, type PortForward } from "./discovery.js";

export type PodInfo = {
  name: string;
  component: string;
  phase: string;
  ready: number;
  total: number;
  restarts: number;
  created: string;
  node: string;
  labels: Readonly<Record<string, string>>;
  lastRestart: string | null;
  lastReason: string | null;
  lastExitCode: number | null;
  runningSince: string | null;
  readinessProbe: boolean;
  readyCondition: boolean;
  claims: readonly string[];
  containers: readonly { name: string; ready: boolean; state: string; stateReason: string; cpu?: string; memory?: string }[];
};

export type ServiceInfo = { name: string; component: string; ports: readonly string[]; selector: Readonly<Record<string, string>> };
export type ProjectOverview = {
  directory: string;
  name: string;
  context: string;
  namespace: string;
  pods: readonly PodInfo[];
  services: readonly ServiceInfo[];
  links: readonly { url: string; source: "proxy" | "ingress" }[];
  metrics: "available" | "unavailable";
  hostMetrics?: { node: string; cpu: string; memory: string; memoryPercent: string; network: string };
  warnings: readonly string[];
};

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const label = (value: unknown): string => /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/iu.test(text(value)) ? text(value) : "";

async function command(binary: string, args: string[], directory: string, maxBuffer = 8_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { cwd: directory, timeout: 8_000, maxBuffer }, (error, stdout, stderr) => {
      if (error) reject(new Error(text(stderr).trim() || error.message));
      else resolve(stdout);
    });
  });
}

async function optionalCommand(binary: string, args: string[], directory: string): Promise<string | null> {
  try { return await command(binary, args, directory); } catch { return null; }
}

async function projectConfig(directory: string): Promise<{ name: string; selectors: string[] }> {
  let config: RecordValue = {};
  for (const filename of ["devspace.yaml", "devspace.yml"]) {
    try { config = object(parse(await readFile(join(directory, filename), "utf8"))); break; }
    catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  const name = label(config.name);
  if (!name) throw new Error("Nome do projeto DevSpace ausente ou invalido.");
  const selectors = Object.values(object(config.dev)).map((value) => object(object(value).labelSelector))
    .map((values) => Object.entries(values).filter(([key, value]) => /^[a-z0-9][a-z0-9./-]*$/iu.test(key) && label(value))
      .map(([key, value]) => `${key}=${value}`).join(","))
    .filter(Boolean);
  return { name, selectors: [...new Set(selectors)] };
}

async function projectLocation(directory: string): Promise<{ context: string; namespace: string }> {
  let cache: RecordValue = {};
  try { cache = object(parse(await readFile(join(directory, ".devspace", "cache.yaml"), "utf8"))); }
  catch (error) { if (!isMissing(error)) throw error; }
  const saved = object(cache.lastContext);
  const context = text(saved.context) || (await command("kubectl", ["config", "current-context"], directory)).trim();
  const namespace = text(saved.namespace) || (await optionalCommand("kubectl", ["config", "view", "--minify", "-o", "jsonpath={.contexts[0].context.namespace}"], directory))?.trim() || "default";
  return { context, namespace };
}

function kubectlArgs(context: string, namespace: string, args: string[]): string[] {
  return ["--context", context, "-n", namespace, "--request-timeout=5s", ...args];
}

async function listResources(directory: string, context: string, namespace: string, kind: string, selector: string): Promise<RecordValue[]> {
  const output = await command("kubectl", kubectlArgs(context, namespace, ["get", kind, "-l", selector, "-o", "json"]), directory);
  return array(object(JSON.parse(output)).items).map(object);
}

function containers(pod: RecordValue): PodInfo["containers"] {
  return array(object(pod.status).containerStatuses).map((value) => {
    const status = object(value);
    const state = object(status.state);
    const current = Object.keys(state)[0] ?? "unknown";
    return { name: text(status.name), ready: status.ready === true, state: current, stateReason: text(object(state[current]).reason) };
  });
}

function podInfo(pod: RecordValue): PodInfo {
  const metadata = object(pod.metadata);
  const statuses = containers(pod);
  const rawStatuses = array(object(pod.status).containerStatuses);
  const restarts = rawStatuses.map((entry) => object(object(object(entry).lastState).terminated));
  const last = restarts.filter((entry) => text(entry.finishedAt)).sort((a, b) => text(b.finishedAt).localeCompare(text(a.finishedAt)))[0];
  const conditions = array(object(pod.status).conditions).map(object);
  const labels = Object.fromEntries(Object.entries(object(metadata.labels)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return {
    name: text(metadata.name),
    component: text(object(metadata.labels)["app.kubernetes.io/component"]) || text(metadata.name).split("-")[0] || "pod",
    phase: text(object(pod.status).phase) || "Unknown",
    ready: statuses.filter((item) => item.ready).length,
    total: array(object(pod.spec).containers).length,
    restarts: array(object(pod.status).containerStatuses).reduce<number>((sum, item) => sum + (Number(object(item).restartCount) || 0), 0),
    created: text(metadata.creationTimestamp),
    node: text(object(pod.spec).nodeName),
    labels,
    lastRestart: last ? text(last.finishedAt) : null,
    lastReason: last ? text(last.reason) || null : null,
    lastExitCode: last && typeof last.exitCode === "number" ? last.exitCode : null,
    runningSince: rawStatuses.map((entry) => text(object(object(object(entry).state).running).startedAt)).filter(Boolean).sort().at(-1) ?? null,
    readinessProbe: array(object(pod.spec).containers).every((entry) => !!object(entry).readinessProbe),
    readyCondition: conditions.find((condition) => condition.type === "Ready")?.status === "True",
    claims: array(object(pod.spec).volumes).map((entry) => text(object(object(entry).persistentVolumeClaim).claimName)).filter(Boolean),
    containers: statuses,
  };
}

function serviceInfo(service: RecordValue): ServiceInfo {
  const metadata = object(service.metadata);
  return {
    name: text(metadata.name),
    component: text(object(metadata.labels)["app.kubernetes.io/component"]),
    selector: Object.fromEntries(Object.entries(object(object(service.spec).selector)).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    ports: array(object(service.spec).ports).map((item) => {
      const port = object(item);
      return `${text(port.name) || "tcp"}:${String(port.port ?? "?")}`;
    }),
  };
}

function ingressLinks(ingresses: RecordValue[]): ProjectOverview["links"] {
  const links = new Set<string>();
  for (const ingress of ingresses) {
    const spec = object(ingress.spec);
    const tlsHosts = new Set(array(spec.tls).flatMap((item) => array(object(item).hosts).map(text)));
    for (const rule of array(spec.rules)) {
      const host = text(object(rule).host);
      if (host) links.add(`${tlsHosts.has(host) ? "https" : "http"}://${host}/`);
    }
  }
  return [...links].sort().map((url) => ({ url, source: "ingress" }));
}

async function listeningPorts(pid: number): Promise<Set<number>> {
  if (process.platform !== "linux") return new Set();
  try {
    const fds = await readdir(`/proc/${pid}/fd`);
    const sockets = new Set((await Promise.all(fds.map(async (fd) => {
      try { return (await readlink(`/proc/${pid}/fd/${fd}`)).match(/^socket:\[(\d+)\]$/u)?.[1]; }
      catch { return undefined; }
    }))).filter((inode): inode is string => !!inode));
    const ports = new Set<number>();
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      for (const line of (await readFile(file, "utf8")).split("\n").slice(1)) {
        const columns = line.trim().split(/\s+/u);
        if (columns[3] !== "0A" || !sockets.has(columns[9] ?? "")) continue;
        const port = parseInt(columns[1]?.split(":")[1] ?? "", 16);
        if (Number.isInteger(port)) ports.add(port);
      }
    }
    return ports;
  } catch (error) {
    if (isMissing(error)) return new Set();
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function inspectProject(directory: string, pid: number | null): Promise<ProjectOverview> {
  const config = await projectConfig(directory);
  const { context, namespace } = await projectLocation(directory);
  const selector = `app.kubernetes.io/name=${config.name}`;
  const warnings: string[] = [];
  let pods = await listResources(directory, context, namespace, "pods", selector);
  if (!pods.length && config.selectors.length) {
    const results = await Promise.all(config.selectors.map((item) => listResources(directory, context, namespace, "pods", item)));
    pods = [...new Map(results.flat().map((pod) => [text(object(pod.metadata).name), pod])).values()];
  }
  const [servicesResult, ingressResult, metricsResult, forwardsResult] = await Promise.allSettled([
    listResources(directory, context, namespace, "services", selector),
    listResources(directory, context, namespace, "ingresses", selector),
    command("kubectl", kubectlArgs(context, namespace, ["top", "pods", "-l", selector, "--containers", "--no-headers"]), directory),
    command("devspace", ["list", "ports", "--output", "json", "--no-colors"], directory),
  ]);
  if (servicesResult.status === "rejected") warnings.push(`Servicos: ${servicesResult.reason instanceof Error ? servicesResult.reason.message : String(servicesResult.reason)}`);
  if (ingressResult.status === "rejected") warnings.push("Ingressos indisponiveis neste contexto.");
  const metrics = metricsResult.status === "fulfilled" ? "available" : "unavailable";
  const usage = new Map<string, { cpu: string; memory: string }>();
  if (metricsResult.status === "fulfilled") {
    for (const line of metricsResult.value.split(/\r?\n/u)) {
      const [pod, container, cpu, memory] = line.trim().split(/\s+/u);
      if (pod && container && cpu && memory) usage.set(`${pod}/${container}`, { cpu, memory });
    }
  }
  const summaries = pods.map(podInfo).map((pod) => ({ ...pod, containers: pod.containers.map((container) => ({
    ...container, ...usage.get(`${pod.name}/${container.name}`),
  })) })).sort((a, b) => a.component.localeCompare(b.component) || a.name.localeCompare(b.name));
  let hostMetrics: ProjectOverview["hostMetrics"];
  if (metrics === "unavailable") {
    const node = summaries.find((pod) => pod.node)?.node;
    const output = node ? await optionalCommand("docker", ["stats", "--no-stream", "--format", "{{json .}}", node], directory) : null;
    if (output) {
      try {
        const value = object(JSON.parse(output.trim().split("\n")[0] ?? ""));
        if (text(value.CPUPerc) && text(value.MemUsage)) {
          hostMetrics = { node: node!, cpu: text(value.CPUPerc), memory: text(value.MemUsage), memoryPercent: text(value.MemPerc), network: text(value.NetIO) };
        }
      } catch { /* Docker stats is optional; pod metrics remain unavailable. */ }
    }
    warnings.push(hostMetrics
      ? "Metrics API indisponivel. CPU/memoria exibidas sao do node Docker, nao dos pods."
      : "CPU/memoria indisponiveis (Metrics API e Docker stats sem acesso).");
  }

  const forwards: PortForward[] = [];
  if (forwardsResult.status === "fulfilled") {
    try {
      for (const item of array(JSON.parse(forwardsResult.value))) {
        const value = object(item);
        const [local, target] = text(value.port).split(":").map(Number);
        if (local && target && local <= 65535 && target <= 65535) forwards.push({ localPort: local, targetPort: target });
      }
    } catch {
      warnings.push("Port forwards DevSpace indisponiveis.");
    }
  }
  const listening = pid === null ? new Set<number>() : await listeningPorts(pid);
  const active = forwards.filter((forward) => listening.has(forward.localPort));
  let caddy: string[] = [];
  try { caddy = [...extractCaddySiteUrls(await readFile(join(directory, "Caddyfile"), "utf8"))]; }
  catch (error) { if (!isMissing(error)) throw error; }
  const proxy = resolveCaddyUrls(caddy, active);
  const local = active.map((forward) => `http://localhost:${forward.localPort}/`);
  const links: ProjectOverview["links"] = [
    ...[...new Set([...proxy, ...local])].map((url) => ({ url, source: "proxy" as const })),
    ...ingressLinks(ingressResult.status === "fulfilled" ? ingressResult.value : []),
  ];
  return {
    directory, name: config.name, context, namespace, pods: summaries,
    services: servicesResult.status === "fulfilled" ? servicesResult.value.map(serviceInfo) : [],
    links, metrics, ...(hostMetrics ? { hostMetrics } : {}), warnings,
  };
}

export async function podLogs(overview: ProjectOverview, podName: string, containerName: string): Promise<string[]> {
  const pod = overview.pods.find((item) => item.name === podName);
  if (!pod || !pod.containers.some((item) => item.name === containerName)) throw new Error("Pod ou container fora do projeto selecionado.");
  const stdout = await command("kubectl", kubectlArgs(overview.context, overview.namespace,
    ["logs", `pod/${podName}`, "-c", containerName, "--tail=40", "--timestamps=true"]), overview.directory, 256_000);
  return stdout.trim().split(/\r?\n/u).filter(Boolean).slice(-40);
}

export async function listDevspaceLogs(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(join(directory, ".devspace", "logs"), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
      .map((entry) => entry.name).sort((a, b) => a === "default.log" ? -1 : b === "default.log" ? 1 : a.localeCompare(b));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

export async function tailDevspaceLog(directory: string, filename: string): Promise<string[]> {
  if (!(await listDevspaceLogs(directory)).includes(filename)) throw new Error("Log DevSpace indisponivel neste projeto.");
  const handle = await open(join(directory, ".devspace", "logs", filename), "r");
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(size, 64_000);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, size - length);
    const lines = bytes.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u);
    if (size > length) lines.shift();
    return lines.map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, ""))
      .filter(Boolean).slice(-40);
  } finally {
    await handle.close();
  }
}
