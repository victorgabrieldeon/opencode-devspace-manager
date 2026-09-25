import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { DevSpaceManager, type DevSpaceState, type DevSpaceStatus } from "./manager.js";
import type { PodInfo, ProjectOverview } from "./observability.js";
import { diagnose, routeEdges, summarizeHealth, timeline, type DoctorReport, type TimelineEntry } from "./diagnostics.js";
import { listEnvironment, updateEnvironment, type EnvSnapshot } from "./environment.js";
import { discoverProjects, type DevSpaceProject } from "./projects.js";

const manager = new DevSpaceManager();
const C = {
  canvas: "#11141d", panel: "#1b1f2c", panelAlt: "#202638", border: "#39415a",
  text: "#e1e9ff", muted: "#a5b3d7", blue: "#72a8ff", blueDeep: "#233f85",
  green: "#58e5a6", greenDeep: "#173a30", amber: "#f0c15b", purple: "#b39aff",
  red: "#f28692",
} as const;
type View = "overview" | "projects" | "pods" | "logs" | "urls" | "devspace" | "settings" | "doctor" | "timeline" | "graph" | "metrics" | "environment" | "providers";
const NAV: readonly { view: View; label: string; key: string }[] = [
  { view: "overview", label: "Visao geral", key: "1" },
  { view: "projects", label: "Projetos", key: "2" },
  { view: "pods", label: "Pods", key: "3" },
  { view: "logs", label: "Logs", key: "4" },
  { view: "urls", label: "URLs e proxies", key: "5" },
  { view: "devspace", label: "DevSpace", key: "6" },
  { view: "settings", label: "Configuracoes", key: "7" },
  { view: "doctor", label: "Doctor", key: "8" },
  { view: "timeline", label: "Timeline", key: "9" },
  { view: "graph", label: "Mapa de servicos", key: "0" },
  { view: "metrics", label: "Metricas", key: "m" },
  { view: "environment", label: "Ambiente", key: "v" },
  { view: "providers", label: "Providers", key: "b" },
];

function Frame(props: { title: string; right?: string | undefined; children: JSX.Element; height?: number | undefined; grow?: boolean }) {
  return (
    <box border borderColor={C.border} backgroundColor={C.panel} flexDirection="column"
      {...(props.height === undefined ? {} : { height: props.height })} flexGrow={props.grow ? 1 : 0} flexShrink={props.height === undefined ? 1 : 0} minHeight={0}>
      <box height={2} flexShrink={0} paddingX={1} flexDirection="row" justifyContent="space-between">
        <text fg={C.text}>{props.title}</text>
        <text fg={C.muted}>{props.right ?? ""}</text>
      </box>
      {props.children}
    </box>
  );
}

function Metric(props: { label: string; value: string | number; color: string; bg: string }) {
  return (
    <box border borderColor={props.color} backgroundColor={props.bg} flexDirection="column" flexGrow={1} minWidth={0} paddingX={1}>
      <text> </text>
      <text fg={props.color}>{props.value} {props.label}</text>
    </box>
  );
}

function clip(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}~` : value.padEnd(length);
}

function usageBar(percent: string, width = 20): string {
  const amount = Number.parseFloat(percent);
  if (!Number.isFinite(amount)) return `[${"-".repeat(width)}]`;
  const filled = Math.max(0, Math.min(width, Math.round(amount / 100 * width)));
  return `[${"#".repeat(filled)}${".".repeat(width - filled)}]`;
}

function PodRows(props: { pods: readonly PodInfo[]; selected?: string | undefined; compact?: boolean; onSelect: (name: string) => void }) {
  return (
    <box flexDirection="column">
      <Show when={!props.compact}>
        <text fg={C.muted}>  {clip("NOME", 17)}{clip("STATUS", 11)}{clip("READY", 9)}{clip("REINICIOS", 11)}IDADE</text>
      </Show>
      <For each={props.pods} fallback={<text fg={C.muted}>  Nenhum pod encontrado neste projeto.</text>}>
        {(item) => (
          <box id={`pod-${item.name}`} height={1} backgroundColor={item.name === props.selected ? C.blueDeep : C.panel}
            onMouseDown={() => props.onSelect(item.name)}>
            <Show when={!props.compact} fallback={
              <text fg={item.name === props.selected ? C.text : C.muted}>
                {`${item.name === props.selected ? "> " : "  "}${clip(item.component, 13)} ${clip(item.phase, 9)} ${item.ready}/${item.total}  R${item.restarts}  ${age(item.created)}`}
              </text>
            }>
              <box flexDirection="row">
                <text width={19} fg={item.name === props.selected ? C.text : C.muted}>
                  {`${item.name === props.selected ? "> " : "  "}${clip(item.component, 17)}`}
                </text>
                <text width={11} fg={item.phase === "Running" ? C.green : C.amber} bg={item.phase === "Running" ? C.greenDeep : C.panelAlt}>
                  {clip(item.phase, 11)}
                </text>
                <text width={9} fg={C.text}>{clip(`${item.ready}/${item.total}`, 9)}</text>
                <text width={11} fg={C.muted}>{clip(String(item.restarts), 11)}</text>
                <text fg={C.muted}>{age(item.created)}</text>
              </box>
            </Show>
          </box>
        )}
      </For>
    </box>
  );
}

function PodDetails(props: { pod?: PodInfo | undefined; overview?: ProjectOverview | undefined }) {
  return (
    <box flexDirection="column" paddingX={1}>
      <text> </text>
      <Show when={props.pod} fallback={<text fg={C.muted}>Selecione um pod para ver os detalhes.</text>}>
        {(item) => (
          <box flexDirection="column">
            <box height={1}><text fg={item().ready === item().total && item().total > 0 ? C.green : C.amber}>
              {`${item().phase}  /  ${item().ready}/${item().total} containers prontos`}
            </text></box>
            <box height={1}><text fg={C.muted}>{`Idade       ${age(item().created)}`}</text></box>
            <box height={1}><text fg={C.muted}>{`Reinicios   ${item().restarts}`}</text></box>
            <box height={1}><text fg={C.muted}>{`Node        ${item().node || "?"}`}</text></box>
            <For each={item().containers}>{(container) => (
              <box height={1}><text fg={container.ready ? C.green : C.amber}>
                {`${container.name}  ${container.ready ? "pronto" : container.state}${container.cpu && container.memory ? `  CPU ${container.cpu}  MEM ${container.memory}` : ""}`}
              </text></box>
            )}</For>
            <For each={props.overview?.services.filter((service) => service.component === item().component) ?? []}>
              {(service) => <box height={1}><text fg={C.muted}>{`Servico     ${service.name} / ${service.ports.join(", ")}`}</text></box>}
            </For>
          </box>
        )}
      </Show>
    </box>
  );
}

function UrlRows(props: { overview?: ProjectOverview | undefined; onOpen: (url: string) => void }) {
  return (
    <box flexDirection="column" paddingX={1}>
      <For each={props.overview?.links ?? []} fallback={<text fg={C.muted}>Nenhum proxy ativo ou ingress encontrado.</text>}>
        {(link) => (
          <box flexDirection="column" marginBottom={1} onMouseDown={() => props.onOpen(link.url)}>
            <text fg={C.text}>{new URL(link.url).hostname.split(".")[0]}  *  / {link.source}</text>
            <text fg={C.blue}>{link.url}</text>
          </box>
        )}
      </For>
    </box>
  );
}

function LogLines(props: { lines: readonly string[]; empty?: string; maxLine?: number }) {
  return (
    <box flexDirection="column" paddingX={1}>
      <For each={props.lines} fallback={<text fg={C.muted}>{props.empty ?? "Sem logs recentes."}</text>}>
        {(line) => <text fg={/\b(ERROR|FATAL)\b/iu.test(line) ? C.red : /\bWARN\b/iu.test(line) ? C.amber : C.muted}>
          {props.maxLine ? clip(line, props.maxLine).trimEnd() : line}
        </text>}
      </For>
    </box>
  );
}

function Dashboard(props: { roots: readonly string[]; initialView?: View | undefined }) {
  const ctx = usePlugin();
  const [projects, setProjects] = createSignal<readonly DevSpaceProject[]>([]);
  const [statuses, setStatuses] = createSignal<Record<string, DevSpaceStatus>>({});
  const [overviews, setOverviews] = createSignal<Record<string, ProjectOverview>>({});
  const [selected, setSelected] = createSignal("");
  const [view, setView] = createSignal<View>(props.initialView ?? "overview");
  const [width, setWidth] = createSignal(ctx.renderer.width);
  const [height, setHeight] = createSignal(ctx.renderer.height);
  const [clock, setClock] = createSignal(new Date());
  const [selectedPod, setSelectedPod] = createSignal("");
  const [logs, setLogs] = createSignal<readonly string[]>([]);
  const [logQuery, setLogQuery] = createSignal("");
  const [logLevel, setLogLevel] = createSignal<"all" | "error" | "warn">("all");
  const [logsFollow, setLogsFollow] = createSignal(true);
  const [logsPaused, setLogsPaused] = createSignal(false);
  const [showTimestamps, setShowTimestamps] = createSignal(true);
  const [doctor, setDoctor] = createSignal<DoctorReport>();
  const [doctorError, setDoctorError] = createSignal("");
  const [doctorLoading, setDoctorLoading] = createSignal(false);
  const [aiLoading, setAiLoading] = createSignal(false);
  const [history, setHistory] = createSignal<readonly TimelineEntry[]>([]);
  const [historyLoading, setHistoryLoading] = createSignal(false);
  const [envSnapshot, setEnvSnapshot] = createSignal<EnvSnapshot>();
  const [envSelected, setEnvSelected] = createSignal("");
  const [envLoading, setEnvLoading] = createSignal(false);
  const [envBusy, setEnvBusy] = createSignal(false);
  const [envError, setEnvError] = createSignal("");
  const [modalOpen, setModalOpen] = createSignal(false);
  const [devspaceFile, setDevspaceFile] = createSignal("");
  const [devspaceFiles, setDevspaceFiles] = createSignal<readonly string[]>([]);
  const [devspaceLines, setDevspaceLines] = createSignal<readonly string[]>([]);
  const [devspaceError, setDevspaceError] = createSignal("");
  const [observing, setObserving] = createSignal(false);
  const [logsLoading, setLogsLoading] = createSignal(false);
  const [inspectError, setInspectError] = createSignal("");
  const [logsError, setLogsError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal("");
  let disposed = false;
  let generation = 0;
  let inspectionGeneration = 0;
  let logGeneration = 0;
  let inspectingDirectory = "";
  let scroll: ScrollBoxRenderable | undefined;
  let podScroll: ScrollBoxRenderable | undefined;
  let logScroll: ScrollBoxRenderable | undefined;
  let urlScroll: ScrollBoxRenderable | undefined;

  const current = () => statuses()[selected()];
  const overview = () => overviews()[selected()];
  const pod = () => overview()?.pods.find((item) => item.name === selectedPod()) ?? overview()?.pods[0];
  const wide = () => width() >= 145 && height() >= 32;
  const readyPods = () => overview()?.pods.filter((item) => item.total > 0 && item.ready === item.total).length ?? 0;
  const restartCount = () => overview()?.pods.reduce((sum, item) => sum + item.restarts, 0) ?? 0;
  const health = () => overview() ? summarizeHealth(overview()!, clock().getTime()) : undefined;
  const filteredLogs = () => logs().filter((line) => {
    const level = logLevel();
    return (level === "all" || level === "error" && /\b(ERROR|FATAL)\b/iu.test(line)
      || level === "warn" && /\bWARN(?:ING)?\b/iu.test(line))
      && line.toLowerCase().includes(logQuery().toLowerCase());
  }).map((line) => showTimestamps() ? line : line.replace(/^\d{4}-\d\d-\d\dT\S+\s*/u, ""));
  const envEntry = () => envSnapshot()?.entries.find((item) => item.name === envSelected()) ?? envSnapshot()?.entries[0];
  const label = (directory: string) => projects().find((project) => project.directory === directory)?.name ?? basename(directory);
  const canStart = () => !!selected() && !busy() && !["running", "starting", "stopping"].includes(current()?.state ?? "")
    && !(current()?.state === "external" && current()?.pid !== null);
  const canStop = () => !!selected() && !busy() && ["running", "starting"].includes(current()?.state ?? "");
  const canRestart = () => !!selected() && !busy() && current()?.state === "running";
  const canOpen = () => !busy() && !!(overview()?.links.length || current()?.links.length);
  const statusColor = (state: DevSpaceState) => {
    if (state === "running") return C.green;
    if (state === "external") return C.blue;
    if (state === "starting" || state === "stopping") return C.amber;
    if (state === "failed") return C.red;
    return C.muted;
  };

  async function dialog<T>(run: () => Promise<T>): Promise<T> {
    setModalOpen(true);
    try { return await run(); }
    finally { setModalOpen(false); }
  }

  async function fetchOverview(directory: string) {
    if (!directory || (observing() && inspectingDirectory === directory)) return;
    const version = ++inspectionGeneration;
    inspectingDirectory = directory;
    setObserving(true);
    try {
      const value = await manager.inspect(directory);
      if (disposed || version !== inspectionGeneration) return;
      setOverviews((previous) => ({ ...previous, [directory]: value }));
      setInspectError("");
      if (selected() === directory && !value.pods.some((item) => item.name === selectedPod())) setSelectedPod(value.pods[0]?.name ?? "");
      if (selected() === directory && value.pods.length) void fetchLogs();
      if (selected() === directory && view() === "doctor") void loadDoctor(value);
      if (selected() === directory && view() === "timeline") void loadTimeline(value);
    } catch (cause) {
      if (!disposed && version === inspectionGeneration) setInspectError(message(cause));
    } finally {
      if (!disposed && version === inspectionGeneration) setObserving(false);
    }
  }

  async function fetchLogs(force = false) {
    const value = overview();
    const target = pod();
    if (!value || !target || logsLoading() || logsPaused() || !logsFollow() && !force) return;
    const version = ++logGeneration;
    const directory = selected();
    setLogsLoading(true);
    try {
      const result = await manager.podLogs(value, target.name, target.containers[0]?.name ?? "");
      if (disposed || version !== logGeneration || selected() !== directory || pod()?.name !== target.name) return;
      setLogs(result);
      setLogsError("");
    } catch (cause) {
      if (!disposed && version === logGeneration) setLogsError(message(cause));
    } finally {
      if (!disposed && version === logGeneration) setLogsLoading(false);
    }
  }

  async function loadDoctor(value = overview()) {
    if (!value || doctorLoading()) return;
    const directory = selected();
    setDoctorLoading(true);
    try {
      const result = await diagnose(value, current()!);
      if (!disposed && selected() === directory) { setDoctor(result); setDoctorError(""); }
    } catch (cause) {
      if (!disposed && selected() === directory) setDoctorError(message(cause));
    } finally { if (!disposed) setDoctorLoading(false); }
  }

  async function loadTimeline(value = overview()) {
    if (!value || historyLoading()) return;
    const directory = selected();
    setHistoryLoading(true);
    try {
      const result = await timeline(value);
      if (!disposed && selected() === directory) setHistory(result);
    } catch (cause) {
      if (!disposed && selected() === directory) setError(message(cause));
    } finally { if (!disposed) setHistoryLoading(false); }
  }

  async function fetchDevspaceLogs() {
    const directory = selected();
    const filename = devspaceFile();
    if (!directory || !filename) return;
    try {
      const lines = await manager.devspaceLogs(directory, filename);
      if (!disposed && selected() === directory && devspaceFile() === filename) {
        setDevspaceLines(lines);
        setDevspaceError("");
      }
    } catch (cause) {
      if (!disposed && selected() === directory && devspaceFile() === filename) setDevspaceError(message(cause));
    }
  }

  async function refresh() {
    const version = ++generation;
    setLoading(true);
    try {
      const found = [...await discoverProjects(props.roots)];
      const location = ctx.location ?? ctx.data.location.default();
      if (location?.directory) {
        const active = await manager.status(location.directory);
        if (active.detected && !found.some((project) => project.directory === active.directory)) {
          found.push({ name: basename(active.directory), directory: active.directory, configFile: active.configFile! });
        }
      }
      const states = await Promise.all(found.map((project) => manager.status(project.directory)));
      if (disposed || version !== generation) return;
      setProjects(found);
      setStatuses(Object.fromEntries(states.map((state) => [state.directory, state])));
      setSelected((previous) => found.some((project) => project.directory === previous)
        ? previous
        : found.find((project) => project.directory === location?.directory)?.directory ?? found[0]?.directory ?? "");
      setError("");
    } catch (cause) {
      if (!disposed) setError(message(cause));
    } finally {
      if (!disposed && version === generation) setLoading(false);
    }
  }

  async function refreshSelected() {
    const directory = selected();
    if (!directory || busy()) return;
    try {
      const state = await manager.status(directory);
      if (!disposed) setStatuses((previous) => ({ ...previous, [directory]: state }));
    } catch (cause) {
      if (!disposed) setError(message(cause));
    }
  }

  async function act(action: "start" | "stop" | "restart") {
    const directory = selected();
    if (!directory || busy()) return;
    if (action !== "start") {
      const confirmed = await dialog(() => ctx.ui.dialog.confirm({
        title: `${action === "stop" ? "Parar" : "Reiniciar"} DevSpace`,
        message: `${label(directory)}\n${directory}\n\nIsto interrompe a sessao de desenvolvimento e os port forwards.`,
        label: { confirm: action === "stop" ? "Parar" : "Reiniciar", cancel: "Cancelar" },
      }));
      if (!confirmed || disposed) return;
    }
    setBusy(true);
    try {
      const state = await manager[action](directory);
      if (!disposed) {
        setStatuses((previous) => ({ ...previous, [directory]: state }));
        setError("");
      }
    } catch (cause) {
      if (!disposed) setError(message(cause));
    } finally {
      if (!disposed) setBusy(false);
    }
  }

  async function choose() {
    const options = projects().map((project) => ({
      title: `${project.name}  [${statuses()[project.directory]?.state ?? "..."}]`,
      description: project.directory,
      value: project.directory,
    }));
    if (!options.length) return;
    const directory = await dialog(() => ctx.ui.dialog.select({ title: "Projeto DevSpace", current: selected(), options }));
    if (directory) setSelected(directory);
  }

  async function choosePod() {
    const value = overview();
    if (!value?.pods.length) return;
    const name = await dialog(() => ctx.ui.dialog.select({ title: `${value.name} / pods`, current: pod()?.name, options: value.pods.map((item) => ({
      title: `${item.component}  ${item.ready}/${item.total}  ${item.phase}`,
      description: item.name,
      value: item.name,
    })) }));
    if (name) {
      ++logGeneration;
      setLogsLoading(false);
      setSelectedPod(name);
      setLogs([]);
      setLogsError("");
      void fetchLogs();
    }
  }

  function toggleLogs() {
    if (!pod()) return;
    setDevspaceFile("");
    setView("logs");
    void fetchLogs();
    queueMicrotask(() => { if (!disposed) scroll?.scrollTo(0); });
  }

  async function chooseDevspaceLog() {
    const files = devspaceFiles();
    if (!files.length) return;
    const filename = await dialog(() => ctx.ui.dialog.select({
      title: "Logs DevSpace",
      current: devspaceFile() || files[0],
      options: [
        { title: "Voltar ao resumo", value: "" },
        ...files.map((value) => ({ title: value, value })),
      ],
    }));
    if (filename === undefined) return;
    setDevspaceFile(filename);
    setView(filename ? "devspace" : "overview");
    setDevspaceLines([]);
    setDevspaceError("");
    if (filename) void fetchDevspaceLogs();
    queueMicrotask(() => { if (!disposed) scroll?.scrollTo(0); });
  }

  async function openLink() {
    const links = overview()?.links.map((item) => item.url) ?? current()?.links ?? [];
    if (!links.length) return;
    const url = await dialog(() => ctx.ui.dialog.select({ title: "Abrir servico", options: links.map((value) => ({ title: value, value })) }));
    if (!url) return;
    try {
      await manager.openUrl(url);
    } catch (cause) {
      setError(message(cause));
    }
  }

  async function openUrl(url: string) {
    try { await manager.openUrl(url); }
    catch (cause) { setError(message(cause)); }
  }

  async function shellIntoPod() {
    const value = overview();
    const target = pod();
    const container = target?.containers[0]?.name;
    if (!value || !target || !container) return;
    ctx.renderer.suspend();
    try {
      const args = ["--context", value.context, "-n", value.namespace, "exec", "-it", `pod/${target.name}`, "-c", container, "--", "/bin/sh"];
      const exit = await new Promise<number | null>((resolve, reject) => {
        const child = spawn("kubectl", args, { cwd: value.directory, stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code) => resolve(code));
      });
      if (exit !== 0) setError(`Shell do pod encerrou com codigo ${exit ?? "desconhecido"}.`);
    } catch (cause) {
      setError(message(cause));
    } finally {
      ctx.renderer.resume();
      void fetchOverview(selected());
    }
  }

  async function searchLogs() {
    const query = await dialog(() => ctx.ui.dialog.prompt({ title: "Buscar nos logs", description: "Filtro local nas ultimas 40 linhas", value: logQuery() }));
    if (query !== undefined) setLogQuery(query.trim());
  }

  async function loadEnvironment(directory = selected()) {
    if (!directory || envLoading()) return;
    setEnvLoading(true);
    try {
      const snapshot = await listEnvironment(directory);
      if (disposed || selected() !== directory) return;
      setEnvSnapshot(snapshot);
      setEnvSelected((previous) => snapshot.entries.some((entry) => entry.name === previous) ? previous : snapshot.entries[0]?.name ?? "");
      setEnvError("");
    } catch (cause) {
      if (!disposed && selected() === directory) setEnvError(message(cause));
    } finally { if (!disposed) setEnvLoading(false); }
  }

  async function hiddenValue(name: string): Promise<string | undefined> {
    ctx.renderer.suspend();
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        const script = 'IFS= read -r -s -p "Novo valor de $1 (oculto; Enter vazio cancela): " value || exit 1; printf "\\n" >&2; printf "%s" "$value"';
        const child = spawn("bash", ["-c", script, "--", name], { stdio: ["inherit", "pipe", "inherit"] });
        let value = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          value += chunk.toString("utf8");
          if (value.length > 8192) { child.kill(); reject(new Error("Valor excede 8192 caracteres.")); }
        });
        child.once("error", reject);
        child.once("exit", (code) => resolve(code === 0 && value ? value : undefined));
      });
    } finally { ctx.renderer.resume(); }
  }

  async function editEnvironment(entry = envEntry()) {
    const snapshot = envSnapshot();
    const directory = selected();
    if (!entry || !snapshot || !directory || envBusy()) return;
    try {
      const value = entry.sensitive ? await dialog(() => hiddenValue(entry.name)) : await dialog(() => ctx.ui.dialog.prompt({
        title: `Editar ${entry.name}`,
        description: "Novo valor no .env local. O Secret do Kubernetes muda somente no proximo deploy.",
        placeholder: "Novo valor (vazio para limpar)",
      }));
      if (value === undefined) return;
      const confirmed = await dialog(() => ctx.ui.dialog.confirm({
        title: `Salvar ${entry.name}?`,
        message: `Altera apenas ${ctx.ui.format.path(snapshot.path)}. O cluster nao sera atualizado automaticamente.`,
        label: { confirm: "Salvar", cancel: "Cancelar" },
      }));
      if (!confirmed || disposed) return;
      setEnvBusy(true);
      const next = await updateEnvironment(directory, entry.name, value, snapshot.revision);
      if (selected() === directory) {
        setEnvSnapshot(next);
        setEnvSelected(entry.name);
        setEnvError("");
        ctx.ui.toast.show({ message: `${entry.name} salva no .env local. Reimplante para atualizar o Kubernetes.`, variant: "success" });
      }
    } catch (cause) { setEnvError(message(cause)); }
    finally { setEnvBusy(false); }
  }

  async function clearEnvironment() {
    const entry = envEntry();
    const snapshot = envSnapshot();
    const directory = selected();
    if (!entry || !snapshot || !directory || envBusy()) return;
    const confirmed = await dialog(() => ctx.ui.dialog.confirm({
      title: `Limpar ${entry.name}?`,
      message: "O valor ficara vazio no .env local. O cluster nao sera atualizado automaticamente.",
      label: { confirm: "Limpar", cancel: "Cancelar" },
    }));
    if (!confirmed || disposed) return;
    setEnvBusy(true);
    try {
      const next = await updateEnvironment(directory, entry.name, "", snapshot.revision);
      if (selected() === directory) { setEnvSnapshot(next); setEnvError(""); }
    } catch (cause) { setEnvError(message(cause)); }
    finally { setEnvBusy(false); }
  }

  async function analyzePod() {
    const value = overview();
    const target = pod();
    if (!value || !target || aiLoading()) return;
    setAiLoading(true);
    try {
      const session = await ctx.client.session.create({
        title: `DevSpace debug: ${target.component}`,
        location: { directory: value.directory },
      });
      const evidence = [
        `Projeto: ${value.name}; contexto ${value.context}; namespace ${value.namespace}.`,
        `Pod: ${target.name}; fase ${target.phase}; prontos ${target.ready}/${target.total}; reinicios ${target.restarts}.`,
        `Ultima saida: ${target.lastReason ?? "desconhecida"}; codigo ${target.lastExitCode ?? "desconhecido"}; em ${target.lastRestart ?? "data desconhecida"}.`,
        `Node: ${target.node}; readiness probe ${target.readinessProbe ? "presente" : "ausente"}.`,
      ].join("\n");
      await ctx.client.session.prompt({
        sessionID: session.id,
        text: `Investigue este pod DevSpace. Use apenas consultas de leitura ao projeto e ao Kubernetes.\n${evidence}\nExplique evidencias, causas provaveis, grau de confianca e proximos passos. Nao edite arquivos nem execute reparos sem pedido explicito. Nao exiba segredos ou variaveis sensiveis.`,
      });
      ctx.ui.router.navigate({ type: "session", sessionID: session.id });
    } catch (cause) {
      setError(`AI Debugger: ${message(cause)}`);
    } finally { setAiLoading(false); }
  }

  function copyUrls() {
    const urls = overview()?.links.map((link) => link.url) ?? [];
    if (!urls.length) return;
    ctx.ui.toast.show({ message: ctx.renderer.copyToClipboardOSC52(urls.join("\n")) ? "URLs copiadas." : "Terminal sem suporte a copia via OSC52." });
  }

  function selectPod(name: string) {
    if (pod()?.name === name) return;
    ++logGeneration;
    setLogsLoading(false);
    setSelectedPod(name);
    setLogs([]);
    void fetchLogs();
  }

  function movePod(direction: number) {
    if (view() === "environment") {
      const entries = envSnapshot()?.entries ?? [];
      const index = entries.findIndex((item) => item.name === envEntry()?.name);
      const next = entries[Math.max(0, Math.min(entries.length - 1, index + direction))];
      if (next) {
        setEnvSelected(next.name);
        queueMicrotask(() => scroll?.scrollChildIntoView(`env-${next.name}`));
      }
      return;
    }
    const list = overview()?.pods ?? [];
    if (list.length && (view() === "overview" || view() === "pods")) {
      const index = list.findIndex((item) => item.name === pod()?.name);
      const next = list[Math.max(0, Math.min(list.length - 1, index + direction))];
      if (!next || next.name === pod()?.name) return;
      selectPod(next.name);
      queueMicrotask(() => (wide() && view() === "overview" ? podScroll : scroll)?.scrollChildIntoView(`pod-${next.name}`));
      return;
    }
    (view() === "logs" ? logScroll : view() === "urls" ? urlScroll : scroll)?.scrollBy(direction * 3);
  }

  ctx.keymap.layer(() => ({
    mode: "global",
    enabled: () => !modalOpen(),
    commands: [
      { id: "devspace.project", title: "Selecionar projeto DevSpace", bind: "p", enabled: () => projects().length > 0, run: choose },
      { id: "devspace.pod", title: "Selecionar pod DevSpace", bind: "d", enabled: () => !!pod(), run: choosePod },
      { id: "devspace.logs", title: "Ver logs do pod", bind: "l", enabled: () => !!pod(), run: toggleLogs },
      { id: "devspace.session.logs", title: "Ver logs DevSpace", bind: "g", enabled: () => devspaceFiles().length > 0, run: chooseDevspaceLog },
      { id: "devspace.refresh", title: "Atualizar DevSpace", bind: "r", enabled: () => !busy(), run: async () => { await refresh(); void fetchOverview(selected()); if (view() === "environment") void loadEnvironment(); } },
      { id: "devspace.start", title: "Iniciar DevSpace", bind: "s", enabled: canStart, run: () => act("start") },
      { id: "devspace.stop", title: "Parar DevSpace", bind: "x", enabled: canStop, run: () => act("stop") },
      { id: "devspace.restart", title: "Reiniciar DevSpace", bind: "t", enabled: canRestart, run: () => act("restart") },
      { id: "devspace.open", title: "Abrir URL DevSpace", bind: "o", enabled: canOpen, run: openLink },
      { id: "devspace.down", title: "Proximo pod ou rolar", bind: "j", run: () => movePod(1) },
      { id: "devspace.up", title: "Pod anterior ou rolar", bind: "k", run: () => movePod(-1) },
      { id: "devspace.view.overview", title: "Visao geral", bind: "1", run: () => setView("overview") },
      { id: "devspace.view.projects", title: "Projetos", bind: "2", run: () => setView("projects") },
      { id: "devspace.view.pods", title: "Pods", bind: "3", run: () => setView("pods") },
      { id: "devspace.view.logs", title: "Logs", bind: "4", run: toggleLogs },
      { id: "devspace.view.urls", title: "URLs e proxies", bind: "5", run: () => setView("urls") },
      { id: "devspace.view.devspace", title: "DevSpace", bind: "6", run: () => setView("devspace") },
      { id: "devspace.view.settings", title: "Configuracoes", bind: "7", run: () => setView("settings") },
      { id: "devspace.view.doctor", title: "Doctor", bind: "8", run: () => setView("doctor") },
      { id: "devspace.view.timeline", title: "Timeline", bind: "9", run: () => setView("timeline") },
      { id: "devspace.view.graph", title: "Mapa de servicos", bind: "0", run: () => setView("graph") },
      { id: "devspace.view.metrics", title: "Metricas", bind: "m", run: () => setView("metrics") },
      { id: "devspace.view.environment", title: "Variaveis de ambiente", bind: "v", run: () => setView("environment") },
      { id: "devspace.view.providers", title: "Providers das aplicacoes", bind: "b", run: () => setView("providers") },
      { id: "devspace.environment.edit", title: "Editar variavel local", bind: "e", enabled: () => view() === "environment" && !!envEntry() && !envBusy(), run: () => editEnvironment() },
      { id: "devspace.environment.clear", title: "Limpar variavel local", bind: "shift+d", enabled: () => view() === "environment" && !!envEntry() && !envBusy(), run: clearEnvironment },
      { id: "devspace.shell", title: "Shell no pod selecionado", bind: "shift+s", enabled: () => !!pod(), run: shellIntoPod },
      { id: "devspace.analyze", title: "Analisar pod com IA", bind: "shift+a", enabled: () => !!pod() && !aiLoading(), run: analyzePod },
      { id: "devspace.urls.copy", title: "Copiar URLs", bind: "c", enabled: () => view() === "urls" && !!overview()?.links.length, run: copyUrls },
      { id: "devspace.logs.search", title: "Buscar nos logs", bind: "/", enabled: () => view() === "logs", run: searchLogs },
      { id: "devspace.logs.follow", title: "Alternar follow dos logs", bind: "f", enabled: () => view() === "logs", run: () => { setLogsFollow((value) => !value); if (logsFollow()) void fetchLogs(true); } },
      { id: "devspace.logs.pause", title: "Pausar logs", bind: "space", enabled: () => view() === "logs", run: () => { setLogsPaused((value) => !value); if (!logsPaused()) void fetchLogs(true); } },
      { id: "devspace.logs.errors", title: "Filtrar erros", bind: "e", enabled: () => view() === "logs", run: () => setLogLevel((value) => value === "error" ? "all" : "error") },
      { id: "devspace.logs.warnings", title: "Filtrar avisos", bind: "w", enabled: () => view() === "logs", run: () => setLogLevel((value) => value === "warn" ? "all" : "warn") },
      { id: "devspace.logs.clear", title: "Limpar logs visiveis", bind: "c", enabled: () => view() === "logs", run: () => { setLogsPaused(true); setLogs([]); } },
      { id: "devspace.logs.timestamps", title: "Alternar timestamps", bind: "t", enabled: () => view() === "logs", run: () => setShowTimestamps((value) => !value) },
      { id: "devspace.view.urls.shortcut", title: "Ver URLs", bind: "u", run: () => setView("urls") },
      { id: "devspace.exit", title: "Sair do DevSpace", bind: "q", run: () => ctx.ui.router.navigate({ type: "home" }) },
      { id: "devspace.help", title: "Ajuda do DevSpace", bind: "?", run: () => dialog(() => ctx.ui.dialog.alert({
        title: "DevSpace / atalhos",
        message: "1-9/0 secoes, m metricas, v ambiente, b providers  |  j/k navegar  |  e editar env  |  D limpar env  |  p projeto  |  d pod  |  l logs  |  g logs DevSpace  |  S shell  |  A analisar  |  o URL  |  c copiar URLs  |  / buscar logs  |  f follow  |  espaco pausa  |  r atualizar  |  q sair",
      })) },
      { id: "devspace.back", title: "Voltar ao resumo ou OpenCode", bind: "escape", run: () => view() === "overview" ? ctx.ui.router.navigate({ type: "home" }) : setView("overview") },
    ],
  }));

  onMount(() => {
    const resize = (nextWidth: number, nextHeight: number) => { setWidth(nextWidth); setHeight(nextHeight); };
    ctx.renderer.on("resize", resize);
    const clockTimer = setInterval(() => setClock(new Date()), 30_000);
    void refresh();
    const timer = setInterval(() => void refreshSelected(), 4_000);
    const detailsTimer = setInterval(() => {
      void fetchOverview(selected());
      if (overview()?.pods.length && ["overview", "pods", "logs"].includes(view())) void fetchLogs();
      if (devspaceFile()) void fetchDevspaceLogs();
      if (selected()) {
        const directory = selected();
        void manager.devspaceLogFiles(directory).then((files) => { if (!disposed && selected() === directory) setDevspaceFiles(files); })
          .catch((cause) => { if (!disposed && selected() === directory) setDevspaceError(message(cause)); });
      }
    }, 12_000);
    onCleanup(() => {
      disposed = true;
      clearInterval(timer);
      clearInterval(detailsTimer);
      clearInterval(clockTimer);
      ctx.renderer.off("resize", resize);
    });
  });

  createEffect(on(selected, (directory) => {
    if (!directory) return;
    ++logGeneration;
    setLogsLoading(false);
    setSelectedPod("");
    setLogs([]);
    setDoctor(undefined);
    setHistory([]);
    if (!props.initialView) setView("overview");
    setDevspaceFile("");
    setDevspaceFiles([]);
    setDevspaceLines([]);
    setInspectError("");
    setDevspaceError("");
    setEnvSnapshot(undefined);
    setEnvSelected("");
    setEnvError("");
    void manager.devspaceLogFiles(directory).then((files) => { if (!disposed && selected() === directory) setDevspaceFiles(files); })
      .catch((cause) => { if (!disposed && selected() === directory) setDevspaceError(message(cause)); });
    void fetchOverview(directory);
  }));

  createEffect(on(view, (next) => {
    if (next === "doctor") void loadDoctor();
    if (next === "timeline") void loadTimeline();
    if (next === "environment") void loadEnvironment();
  }));

  return (
    <box flexDirection="column" height="100%" backgroundColor={C.canvas}>
      <text> </text>
      <box height={3} flexShrink={0} border={["bottom"]} borderColor={C.border} backgroundColor={C.panel} paddingX={1} flexDirection="row" alignItems="center">
        <text fg={C.blue}>[+]</text>
        <text fg={C.text}> DEVSPACE </text>
        <text fg={C.purple}>v0.1.0</text>
        <text fg={C.muted}>  |  {clip(selected() ? ctx.ui.format.path(selected()) : "~/code", wide() ? 48 : Math.max(14, width() - 45))}</text>
        <Show when={wide()}><text fg={C.muted}> | {projects().length} {projects().length === 1 ? "projeto" : "projetos"}  {overview()?.pods.length ?? 0} pods  {clock().toLocaleString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</text></Show>
      </box>

      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <Show when={wide()}>
          <box width={24} flexShrink={0} backgroundColor={C.panel} border={["right"]} borderColor={C.border} flexDirection="column" padding={1} gap={height() >= 46 ? 1 : 0}>
            <For each={NAV}>{(entry) => (
              <box height={2} backgroundColor={view() === entry.view ? C.blueDeep : C.panel} paddingX={1}
                onMouseDown={() => setView(entry.view)}>
                <text fg={view() === entry.view ? C.text : C.muted}>{entry.key}  {entry.label}</text>
              </box>
            )}</For>
          </box>
        </Show>

        <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0} padding={wide() ? 1 : 0} gap={wide() ? 1 : 0}>
          <Show when={error()}><text fg={C.red}>{error()}</text></Show>
          <Show when={loading() && !current()}><text fg={C.muted}>Buscando projetos DevSpace...</text></Show>
          <Show when={!loading() && !projects().length}>
            <Frame title="Nenhum projeto encontrado">
              <box padding={1} flexDirection="column">
                <text fg={C.muted}>Procure devspace.yaml ou devspace.yml em {props.roots.join(", ")}.</text>
                <text fg={C.blue}>r  Buscar novamente</text>
              </box>
            </Frame>
          </Show>

          <Show when={current()}>{(state) => (
            <>
              <Show when={view() === "overview"}>
                <box height={wide() ? 7 : 4} flexShrink={0} border borderColor={C.border} backgroundColor={C.panel} flexDirection="row" paddingX={1} gap={1}>
                  <box flexGrow={1} minWidth={0} flexDirection="column">
                    <Show when={wide()}><text> </text></Show>
                    <text fg={C.text}>{clip(label(state().directory).toUpperCase(), wide() ? 30 : 18)}</text>
                    <Show when={wide()}><text fg={C.muted}>{clip(ctx.ui.format.path(state().directory), 42)}</text></Show>
                    <text fg={health()?.state === "healthy" ? C.green : health()?.state === "degraded" ? C.amber : statusColor(state().state)}>
                      {health() ? health()!.state.toUpperCase() : stateLabel(state().state)}{state().pid ? `  /  PID ${state().pid}` : ""}
                    </text>
                  </box>
                  <Show when={wide()}>
                    <Metric label="Pods" value={overview()?.pods.length ?? "--"} color={C.purple} bg="#222038" />
                    <Metric label="Reinicios" value={overview() ? restartCount() : "--"} color={C.green} bg={C.greenDeep} />
                    <Metric label="Servicos" value={overview()?.services.length ?? "--"} color={C.amber} bg="#352d21" />
                    <Metric label="CPU node" value={overview()?.hostMetrics?.cpu ?? (overview()?.metrics === "available" ? "Pods" : "N/D")} color={C.blue} bg={C.panelAlt} />
                    <Metric label="RAM node" value={overview()?.hostMetrics?.memory.split("/")[0]?.trim() ?? "N/D"} color={C.muted} bg={C.panelAlt} />
                  </Show>
                </box>
                <Show when={!wide() && width() >= 100 && height() >= 28}>
                  <box height={4} flexShrink={0} flexDirection="row" gap={1}>
                    <Metric label="Pods" value={overview()?.pods.length ?? "--"} color={C.purple} bg="#222038" />
                    <Metric label="Reinicios" value={overview() ? restartCount() : "--"} color={C.green} bg={C.greenDeep} />
                    <Metric label="Servicos" value={overview()?.services.length ?? "--"} color={C.amber} bg="#352d21" />
                    <Metric label="CPU node" value={overview()?.hostMetrics?.cpu ?? "N/D"} color={C.blue} bg={C.panelAlt} />
                    <Metric label="RAM node" value={overview()?.hostMetrics?.memory.split("/")[0]?.trim() ?? "N/D"} color={C.muted} bg={C.panelAlt} />
                  </box>
                </Show>
                <Show when={!wide() && (width() < 100 || height() < 28)}>
                  <box flexDirection="column" flexShrink={0}>
                    <text fg={C.muted}>{`${readyPods()}/${overview()?.pods.length ?? 0} pods  /  ${overview()?.services.length ?? 0} servicos  /  ${restartCount()} reinicios`}</text>
                    <text fg={C.blue}>{`Docker node: CPU ${overview()?.hostMetrics?.cpu ?? "N/D"}  /  RAM ${overview()?.hostMetrics?.memory.split("/")[0]?.trim() ?? "N/D"}`}</text>
                  </box>
                </Show>

                <Show when={health()?.findings.length}>
                  <box height={wide() ? 2 : 1} flexShrink={0} backgroundColor={C.panelAlt} paddingX={1} onMouseDown={() => setView("doctor")}>
                    <text fg={C.amber}>{clip(`ATENCAO  ${health()!.findings[0]?.title ?? ""}  (+${Math.max(0, health()!.findings.length - 1)})`, Math.max(30, wide() ? width() - 32 : width() - 5)).trimEnd()}</text>
                  </box>
                </Show>

                <Show when={wide()} fallback={
                  <scrollbox ref={(value) => { scroll = value; }} flexGrow={1} flexShrink={1} minHeight={0} scrollY scrollX={false}>
                    <box flexDirection="column" gap={1}>
                      <Frame title="Pods" right={`${readyPods()}/${overview()?.pods.length ?? 0} prontos`}>
                        <PodRows pods={overview()?.pods ?? []} selected={pod()?.name} compact onSelect={selectPod} />
                      </Frame>
                      <Frame title={pod()?.name ?? "Detalhes do pod"}>
                        <PodDetails pod={pod()} overview={overview()} />
                      </Frame>
                      <Frame title={`URLs e proxies  /  ${overview()?.links.length ?? 0}`}>
                        <UrlRows overview={overview()} onOpen={(url) => void openUrl(url)} />
                      </Frame>
                      <Frame title={`Logs  /  ${pod()?.component ?? "pod"}`}>
                        <LogLines lines={filteredLogs().slice(-8)} empty={logsLoading() ? "Carregando logs..." : "Sem logs para este filtro."} />
                      </Frame>
                    </box>
                  </scrollbox>
                }>
                  <box flexDirection="row" flexGrow={1} minHeight={0} gap={1}>
                    <box width="58%" flexShrink={0} flexDirection="column" minHeight={0} gap={1}>
                      <Frame title="Pods" right={`${readyPods()}/${overview()?.pods.length ?? 0} em execucao`} grow>
                        <scrollbox ref={(value) => { podScroll = value; }} flexGrow={1} minHeight={0} scrollY scrollX={false}>
                          <PodRows pods={overview()?.pods ?? []} selected={pod()?.name} onSelect={selectPod} />
                        </scrollbox>
                      </Frame>
                      <Frame title={`Logs  /  ${pod()?.component ?? "pod"}`} right={logsLoading() ? "Atualizando" : "l Ver todos"} height={13}>
                        <scrollbox ref={(value) => { logScroll = value; }} flexGrow={1} minHeight={0} scrollY scrollX={false}>
                          <LogLines lines={filteredLogs().slice(-10)} maxLine={Math.floor(width() * 0.46)} empty={logsLoading() ? "Carregando logs..." : "Sem logs para este filtro."} />
                        </scrollbox>
                      </Frame>
                    </box>
                    <box flexGrow={1} minWidth={0} flexDirection="column" minHeight={0} gap={1}>
                      <Frame title={pod()?.name ?? "Detalhes do pod"} right={pod()?.node} height={18}>
                        <box flexDirection="column">
                          <PodDetails pod={pod()} overview={overview()} />
                          <text fg={C.blue}>  S Shell   l Logs   A Analisar</text>
                        </box>
                      </Frame>
                      <Frame title="URLs e proxies" right={`${overview()?.links.length ?? 0} links`} grow>
                        <scrollbox ref={(value) => { urlScroll = value; }} flexGrow={1} minHeight={0} scrollY scrollX={false}>
                          <UrlRows overview={overview()} onOpen={(url) => void openUrl(url)} />
                        </scrollbox>
                      </Frame>
                    </box>
                  </box>
                </Show>
              </Show>

              <Show when={view() !== "overview"}>
                <Frame title={NAV.find((entry) => entry.view === view())?.label ?? "DevSpace"} right={`${overview()?.name ?? label(state().directory)} / ${overview()?.namespace ?? "--"}`} grow>
                  <scrollbox ref={(value) => { scroll = value; }} flexGrow={1} minHeight={0} scrollY scrollX={false}>
                    <box flexDirection="column" padding={1} gap={1}>
                      <Show when={view() === "projects"}>
                        <For each={projects()}>{(project) => (
                          <box border borderColor={project.directory === selected() ? C.blue : C.border} backgroundColor={project.directory === selected() ? C.blueDeep : C.panelAlt}
                            paddingX={1} flexDirection="column" onMouseDown={() => { setSelected(project.directory); setView("overview"); }}>
                            <text fg={C.text}>{project.name}  /  {stateLabel(statuses()[project.directory]?.state)}</text>
                            <text fg={C.muted}>{ctx.ui.format.path(project.directory)}  /  {overviews()[project.directory]?.pods.length ?? "--"} pods</text>
                          </box>
                        )}</For>
                        <text fg={C.muted}>p  Escolher projeto  /  1  Voltar ao resumo</text>
                      </Show>
                      <Show when={view() === "pods"}>
                        <PodRows pods={overview()?.pods ?? []} selected={pod()?.name} compact={!wide()} onSelect={selectPod} />
                        <Frame title={pod()?.name ?? "Detalhes"}>
                          <PodDetails pod={pod()} overview={overview()} />
                        </Frame>
                      </Show>
                      <Show when={view() === "logs"}>
                        <text fg={C.blue}>{pod()?.name ?? "Pod"}  /  {pod()?.containers[0]?.name ?? "container"}</text>
                        <text fg={C.muted}>{`Filtro: ${logQuery() || "todos"}  /  ${logLevel()}  /  ${logsPaused() ? "PAUSADO" : logsFollow() ? "FOLLOW" : "MANUAL"}  /  ${showTimestamps() ? "timestamps" : "sem timestamps"}`}</text>
                        <text fg={C.muted}>/ buscar   f follow   espaco pausar   e erros   w avisos   t tempo   c limpar</text>
                        <Show when={logsError()}><text fg={C.red}>{logsError()}</text></Show>
                        <LogLines lines={filteredLogs()} empty={logsLoading() ? "Carregando logs..." : "Sem logs para este filtro."} />
                      </Show>
                      <Show when={view() === "urls"}>
                        <UrlRows overview={overview()} onOpen={(url) => void openUrl(url)} />
                        <text fg={C.muted}>o Abrir URL  /  c Copiar todas</text>
                      </Show>
                      <Show when={view() === "devspace"}>
                        <text fg={statusColor(state().state)}>{stateLabel(state().state)}  {state().pid ? `PID ${state().pid}` : ""}</text>
                        <text fg={C.muted}>{state().message ?? "Sessao de desenvolvimento"}</text>
                        <For each={devspaceFiles()}>{(file) => (
                          <text fg={devspaceFile() === file ? C.blue : C.muted} onMouseDown={() => { setDevspaceFile(file); void fetchDevspaceLogs(); }}>
                            {devspaceFile() === file ? "> " : "  "}{file}
                          </text>
                        )}</For>
                        <Show when={devspaceFile()}>
                          <text fg={C.blue}>Log  /  {devspaceFile()}</text>
                          <Show when={devspaceError()}><text fg={C.red}>{devspaceError()}</text></Show>
                          <LogLines lines={devspaceLines()} />
                        </Show>
                        <Show when={!devspaceFile() && !devspaceFiles().length}><text fg={C.muted}>Nenhum arquivo de log DevSpace encontrado.</text></Show>
                      </Show>
                      <Show when={view() === "settings"}>
                        <text fg={C.text}>Projeto  {overview()?.name ?? label(state().directory)}</text>
                        <text fg={C.muted}>Arquivo    {state().configFile}</text>
                        <text fg={C.muted}>Diretorio  {ctx.ui.format.path(state().directory)}</text>
                        <text fg={C.muted}>Contexto   {overview()?.context ?? "--"}</text>
                        <text fg={C.muted}>Namespace {overview()?.namespace ?? "--"}</text>
                        <text fg={C.muted}>Origem     {state().state === "external" ? "Outra sessao" : "Esta TUI"}</text>
                        <text fg={C.blue}>v Ambiente local  /  b Providers das aplicacoes</text>
                        <For each={overview()?.warnings ?? []}>{(warning) => <text fg={C.amber}>{warning}</text>}</For>
                      </Show>
                      <Show when={view() === "environment"}>
                        <text fg={C.text}>Fonte local: {ctx.ui.format.path(envSnapshot()?.path ?? `${selected()}/.env`)}</text>
                        <text fg={C.amber}>Valores ocultos. Salvar aqui nao atualiza os Secrets do cluster; reimplante o projeto depois.</text>
                        <Show when={envLoading()}><text fg={C.muted}>Lendo nomes das variaveis...</text></Show>
                        <Show when={envError()}><text fg={C.red}>{envError()}</text></Show>
                        <For each={envSnapshot()?.entries ?? []} fallback={<text fg={C.muted}>Nenhuma variavel disponivel em .env.</text>}>
                          {(entry) => (
                            <box id={`env-${entry.name}`} height={1} backgroundColor={entry.name === envEntry()?.name ? C.blueDeep : C.panel}
                              onMouseDown={() => setEnvSelected(entry.name)}>
                              <text fg={entry.name === envEntry()?.name ? C.text : C.muted}>
                                {`${entry.name === envEntry()?.name ? "> " : "  "}${clip(entry.name, 30)}  ${entry.set ? "definida" : "vazia"}  ${entry.sensitive ? "protegida" : "oculta"}  ${entry.source}`}
                              </text>
                            </box>
                          )}
                        </For>
                        <text fg={C.blue}>j/k Selecionar  /  e Editar  /  D Limpar  /  r Recarregar</text>
                      </Show>
                      <Show when={view() === "providers"}>
                        <text fg={C.muted}>Provider do ambiente atual: Kubernetes / {overview()?.context ?? "contexto indisponivel"}</text>
                        <text fg={C.muted}>Node provider e registry sao metadados da imagem; nao representam um deploy de producao.</text>
                        <Show when={overview()?.declaredProductionProvider}>
                          <text fg={C.amber}>Producao: {overview()?.declaredProductionProvider}</text>
                        </Show>
                        <For each={overview()?.providers ?? []} fallback={<text fg={C.muted}>Nenhuma aplicacao detectada no cluster.</text>}>
                          {(provider) => (
                            <box border borderColor={C.border} backgroundColor={C.panelAlt} flexDirection="column" paddingX={1}>
                              <text fg={C.blue}>{provider.component.toUpperCase()}</text>
                              <text fg={C.muted}>Infra    {provider.infrastructure} / {overview()?.namespace ?? "--"}</text>
                              <text fg={C.muted}>Node     {provider.node || "?"}  /  {provider.nodeProvider}</text>
                              <text fg={C.muted}>Registry {provider.registries.join(", ") || "desconhecido"}</text>
                              <For each={provider.images}>{(image) => <text fg={C.text}>Imagem   {image}</text>}</For>
                            </box>
                          )}
                        </For>
                      </Show>
                      <Show when={view() === "doctor"}>
                        <text fg={doctor()?.problems ? C.amber : C.green}>
                          {doctorLoading() ? "Verificando ambiente..." : `${doctor()?.problems ?? 0} problema(s) encontrado(s)`}
                        </text>
                        <Show when={doctorError()}><text fg={C.red}>{doctorError()}</text></Show>
                        <For each={doctor()?.checks ?? []}>{(item) => (
                          <box flexDirection="column" onMouseDown={() => { if (item.pod) { selectPod(item.pod); setView("logs"); } }}>
                            <text fg={item.level === "ok" ? C.green : item.level === "fail" ? C.red : item.level === "warn" ? C.amber : C.muted}>
                              {`${item.level === "ok" ? "[OK]" : item.level === "fail" ? "[X]" : item.level === "warn" ? "[!]" : "[i]"} ${item.title}`}
                            </text>
                            <text fg={C.muted}>     {item.detail}</text>
                          </box>
                        )}</For>
                        <text fg={C.blue}>r Reavaliar  /  clique num pod para logs  /  A Analisar pod com IA</text>
                      </Show>
                      <Show when={view() === "timeline"}>
                        <text fg={C.muted}>{historyLoading() ? "Buscando eventos..." : `${history().length} eventos recentes do projeto`}</text>
                        <For each={history()} fallback={<text fg={C.muted}>Nenhum evento disponivel; eventos do Kubernetes podem expirar.</text>}>
                          {(entry) => <text fg={entry.type === "Warning" ? C.amber : entry.type === "Restart" ? C.blue : C.muted}>
                            {`${new Date(entry.at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}  ${clip(entry.pod.split("-")[0] ?? "pod", 12)}  ${entry.message}`}
                          </text>}
                        </For>
                      </Show>
                      <Show when={view() === "graph"}>
                        <text fg={C.muted}>Relacoes verificadas por selectors dos Services. Dependencias de aplicacao nao sao inferidas.</text>
                        <For each={overview() ? routeEdges(overview()!) : []} fallback={<text fg={C.muted}>Nenhuma relacao Service -&gt; Pod verificavel neste projeto.</text>}>
                          {(edge) => <text fg={C.blue}>{`${clip(edge.service, 20)}  ->  ${edge.pod}`}</text>}
                        </For>
                      </Show>
                      <Show when={view() === "metrics"}>
                        <Show when={overview()?.hostMetrics}>{(host) => (
                          <box flexDirection="column" gap={1}>
                            <text fg={C.amber}>Docker node  /  {host().node}  (nao representa pods individuais)</text>
                            <text fg={C.blue}>{`CPU      ${usageBar(host().cpu)}  ${host().cpu}`}</text>
                            <text fg={C.purple}>{`Memoria  ${usageBar(host().memoryPercent)}  ${host().memory}`}</text>
                            <text fg={C.muted}>Network  {host().network}  /  total acumulado</text>
                          </box>
                        )}</Show>
                        <text fg={C.muted}>Metrics API por pod: {overview()?.metrics === "available" ? "disponivel" : "indisponivel"}</text>
                        <For each={overview()?.pods ?? []}>{(item) => (
                          <text fg={C.muted}>{item.component}  {item.containers.map((container) => `${container.cpu ?? "CPU N/D"} / ${container.memory ?? "MEM N/D"}`).join("  ")}</text>
                        )}</For>
                      </Show>
                      <Show when={inspectError()}><text fg={C.red}>Cluster: {inspectError()}</text></Show>
                      <Show when={observing() && !overview()}><text fg={C.muted}>Consultando cluster...</text></Show>
                    </box>
                  </scrollbox>
                </Frame>
              </Show>
            </>
          )}</Show>
        </box>
      </box>

      <box height={3} flexShrink={0} border={["top"]} borderColor={C.border} backgroundColor={C.panel} paddingX={1} flexDirection="column">
        <text fg={health()?.state === "degraded" || current()?.state === "failed" ? C.amber : C.green}>
          {current() ? `* ${health()?.state.toUpperCase() ?? stateLabel(current()?.state)}  |  ${health() ? `${readyPods()}/${overview()?.pods.length ?? 0} pods  |  ` : ""}${current()?.state === "external" ? "Sessao externa" : "DevSpace local"}${width() >= 90 && overview()?.hostMetrics ? `  |  Docker ${overview()?.hostMetrics?.cpu}` : ""}` : "* DevSpace"}
        </text>
        <text fg={C.muted}>{clip(view() === "environment" ? "v Ambiente   j/k Variaveis   e Editar   D Limpar   r Recarregar   q Sair"
          : wide() ? "1-9/0,m,v,b Secoes   j/k Navegar   o URL   l Logs   S Shell   A Analisar   ? Ajuda   q Sair"
          : "1-9/0 Menu   v Ambiente   b Providers   8 Doctor   q Sair", Math.max(20, width() - 3))}</text>
      </box>
    </box>
  );
}

function stateLabel(state: DevSpaceState | undefined): string {
  switch (state) {
    case "running": return "ATIVO";
    case "starting": return "INICIANDO";
    case "stopping": return "PARANDO";
    case "external": return "OUTRA SESSAO";
    case "failed": return "FALHOU";
    case "stopped": return "PARADO";
    default: return "VERIFICANDO";
  }
}

function age(created: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(created)) / 1000));
  if (!Number.isFinite(seconds)) return "?";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export default Plugin.define({
  id: "devspace-manager.tui",
  setup(ctx) {
    const roots = Array.isArray(ctx.options.roots) && ctx.options.roots.every((value: unknown) => typeof value === "string")
      ? ctx.options.roots as string[]
      : [join(homedir(), "code")];
    const unregister = ctx.ui.router.register({ name: "devspace-manager", render: ({ data }) =>
      <Dashboard roots={roots} initialView={data?.view === "doctor" ? "doctor" : undefined} /> });
    const removeCommands = ctx.ui.slot({ append: "app", render: () => {
      ctx.keymap.layer(() => ({ mode: "global", commands: [
        {
          id: "devspace.dashboard", title: "Gerenciar DevSpace", group: "DevSpace", palette: true,
          slash: { name: "devspace" },
          run: () => ctx.ui.router.navigate({ type: "plugin", name: "devspace-manager" }),
        },
        {
          id: "devspace.doctor.open", title: "DevSpace Doctor", group: "DevSpace", palette: true,
          slash: { name: "devspace-doctor" },
          run: () => ctx.ui.router.navigate({ type: "plugin", name: "devspace-manager", data: { view: "doctor" } }),
        },
      ] }));
      return null;
    } });
    return async () => {
      removeCommands();
      unregister();
      await manager.shutdown();
    };
  },
});
