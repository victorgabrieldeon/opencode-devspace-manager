import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import type { DevSpaceStatus } from "./manager.js";
import type { PodInfo, ProjectOverview } from "./observability.js";

export type Finding = {
  level: "ok" | "info" | "warn" | "fail";
  title: string;
  detail: string;
  pod?: string;
};
export type HealthSummary = {
  state: "healthy" | "degraded" | "unknown";
  ready: number;
  total: number;
  restarts: number;
  stableSince: string | null;
  lastRestart: string | null;
  findings: readonly Finding[];
};
export type DoctorReport = { checks: readonly Finding[]; problems: number };
export type TimelineEntry = { at: string; type: "Normal" | "Warning" | "Restart"; pod: string; message: string };
export type RouteEdge = { service: string; pod: string };

const recent = (date: string | null, now: number, minutes: number) => !!date && Number.isFinite(Date.parse(date))
  && now - Date.parse(date) >= 0 && now - Date.parse(date) < minutes * 60_000;

export function summarizeHealth(overview: ProjectOverview, now = Date.now()): HealthSummary {
  const findings: Finding[] = [];
  for (const pod of overview.pods) {
    if (pod.phase !== "Running" || pod.ready < pod.total || !pod.readyCondition) {
      findings.push({ level: "fail", title: `${pod.component} nao pronto`, detail: `${pod.phase} / ${pod.ready}/${pod.total} containers`, pod: pod.name });
    }
    if (pod.containers.some((container) => container.stateReason === "CrashLoopBackOff")) {
      findings.push({ level: "fail", title: `${pod.component} em crash loop`, detail: `Ultima saida: ${pod.lastReason ?? "desconhecida"}`, pod: pod.name });
    } else if (recent(pod.lastRestart, now, 10)) {
      findings.push({ level: "warn", title: `${pod.component} reiniciou recentemente`, detail: `${pod.restarts} reinicios; ultimo em ${pod.lastRestart}`, pod: pod.name });
    } else if (pod.restarts >= 5) {
      findings.push({ level: "info", title: `${pod.component} historico de reinicios`, detail: `${pod.restarts} reinicios; ultimo em ${pod.lastRestart ?? "data desconhecida"}`, pod: pod.name });
    }
    if (!pod.readinessProbe) findings.push({ level: "info", title: `${pod.component} sem readiness probe`, detail: "Prontidao depende apenas do estado do container.", pod: pod.name });
  }
  if (overview.metrics === "unavailable") findings.push({ level: "info", title: "Metrics API indisponivel", detail: overview.hostMetrics
    ? `Fallback Docker: node ${overview.hostMetrics.node}; nao representa cada pod.` : "CPU/memoria por pod nao podem ser medidas." });
  const running = overview.pods.flatMap((pod) => pod.runningSince ? [pod.runningSince] : []);
  const restarts = overview.pods.flatMap((pod) => pod.lastRestart ? [pod.lastRestart] : []);
  const ready = overview.pods.filter((pod) => pod.phase === "Running" && pod.total > 0 && pod.ready === pod.total && pod.readyCondition).length;
  return {
    state: !overview.pods.length ? "unknown" : findings.some((item) => item.level === "fail" || item.level === "warn") ? "degraded" : "healthy",
    ready, total: overview.pods.length,
    restarts: overview.pods.reduce((sum, pod) => sum + pod.restarts, 0),
    stableSince: running.length === overview.pods.length && running.length ? running.sort().at(-1)! : null,
    lastRestart: restarts.sort().at(-1) ?? null,
    findings,
  };
}

function run(binary: string, args: string[], cwd: string, timeout = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { cwd, timeout, maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout.trim());
    });
  });
}

function kubectl(overview: ProjectOverview, args: string[]): Promise<string> {
  return run("kubectl", ["--context", overview.context, "-n", overview.namespace, "--request-timeout=5s", ...args], overview.directory);
}

export async function diagnose(overview: ProjectOverview, status: DevSpaceStatus): Promise<DoctorReport> {
  const checks: Finding[] = [];
  const [docker, cluster] = await Promise.allSettled([
    run("docker", ["info", "--format", "{{.ServerVersion}}"], overview.directory, 3_000),
    kubectl(overview, ["get", "--raw=/readyz"]),
  ]);
  checks.push(docker.status === "fulfilled"
    ? { level: "ok", title: "Docker daemon", detail: `Versao ${docker.value}` }
    : { level: "warn", title: "Docker daemon", detail: "Indisponivel ou sem permissao." });
  checks.push(cluster.status === "fulfilled" && cluster.value.includes("ok")
    ? { level: "ok", title: "Kubernetes", detail: `${overview.context} / ${overview.namespace}` }
    : { level: "fail", title: "Kubernetes", detail: cluster.status === "rejected" ? String(cluster.reason) : "API nao esta pronta." });

  const host = overview.links.find((link) => link.source === "proxy")?.url;
  if (host) {
    try {
      const address = await lookup(new URL(host).hostname);
      checks.push({ level: "ok", title: "DNS do proxy", detail: `${new URL(host).hostname} -> ${address.address}` });
    } catch {
      checks.push({ level: "warn", title: "DNS do proxy", detail: `${new URL(host).hostname} nao resolve neste host.` });
    }
    checks.push({ level: "ok", title: "Port forward", detail: `${overview.links.filter((link) => link.source === "proxy").length} URL(s) com porta ativa na sessao DevSpace.` });
  } else {
    checks.push({ level: "info", title: "Port forward", detail: "Nenhum proxy local ativo confirmado." });
  }

  const claims = [...new Set(overview.pods.flatMap((pod) => pod.claims))];
  if (claims.length) {
    try {
      const items = (JSON.parse(await kubectl(overview, ["get", "pvc", "-o", "json"])) as { items?: { metadata?: { name?: string }; status?: { phase?: string } }[] }).items ?? [];
      for (const name of claims) {
        const phase = items.find((item) => item.metadata?.name === name)?.status?.phase;
        checks.push({ level: phase === "Bound" ? "ok" : "fail", title: `Volume ${name}`, detail: phase ?? "PVC nao encontrado." });
      }
    } catch {
      checks.push({ level: "warn", title: "Volumes", detail: "Nao foi possivel consultar PVCs neste namespace." });
    }
  }
  const health = summarizeHealth(overview);
  checks.push(...health.findings.filter((item) => item.title !== "Metrics API indisponivel"));
  checks.push({ level: overview.metrics === "available" ? "ok" : "warn", title: "Metricas por pod", detail: overview.metrics === "available"
    ? "Metrics API ativa." : overview.hostMetrics ? `Somente node Docker ${overview.hostMetrics.node}.` : "Metrics API indisponivel." });
  if (status.state === "external") checks.push({ level: "info", title: "Sessao externa", detail: `PID ${status.pid ?? "?"}; diagnostico somente leitura.` });
  return { checks, problems: checks.filter((item) => item.level === "warn" || item.level === "fail").length };
}

export function routeEdges(overview: ProjectOverview): RouteEdge[] {
  return overview.services.flatMap((service) => {
    const labels = Object.entries(service.selector);
    if (!labels.length) return [];
    return overview.pods.filter((pod) => labels.every(([key, value]) => pod.labels[key] === value))
      .map((pod) => ({ service: service.name, pod: pod.component }));
  });
}

export async function timeline(overview: ProjectOverview): Promise<TimelineEntry[]> {
  const names = new Set(overview.pods.map((pod) => pod.name));
  let events: TimelineEntry[] = [];
  try {
    const result = JSON.parse(await kubectl(overview, ["get", "events", "--field-selector", "involvedObject.kind=Pod", "-o", "json"])) as {
      items?: { involvedObject?: { name?: string }; lastTimestamp?: string; eventTime?: string; metadata?: { creationTimestamp?: string }; type?: string; reason?: string; message?: string }[];
    };
    events = (result.items ?? []).filter((item) => names.has(item.involvedObject?.name ?? ""))
      .map((item) => ({ at: item.eventTime || item.lastTimestamp || item.metadata?.creationTimestamp || "",
        type: item.type === "Warning" ? "Warning" as const : "Normal" as const,
        pod: item.involvedObject?.name ?? "", message: `${item.reason ?? "Evento"}: ${(item.message ?? "").slice(0, 140)}` }));
  } catch { /* Kubernetes events expire; restarts below remain useful. */ }
  const restarts: TimelineEntry[] = overview.pods.filter((pod) => !!pod.lastRestart).map((pod) => ({
    at: pod.lastRestart!, type: "Restart", pod: pod.name,
    message: `${pod.component} reiniciou (total ${pod.restarts}; motivo ${pod.lastReason ?? "desconhecido"}).`,
  }));
  return [...events, ...restarts].filter((item) => Number.isFinite(Date.parse(item.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 30);
}
