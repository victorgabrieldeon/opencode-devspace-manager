import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { DevSpaceManager } from "../src/manager.js";
import { inspectProject, listDevspaceLogs, podLogs, tailDevspaceLog } from "../src/observability.js";
import { routeEdges, summarizeHealth, timeline } from "../src/diagnostics.js";
import { discoverProjects } from "../src/projects.js";

const originalPath = process.env["PATH"];
const managers: DevSpaceManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  process.env["PATH"] = originalPath;
});

describe("DevSpace manager", () => {
  test("reads bounded logs from an existing DevSpace session", async () => {
    const project = await mkdtemp(join(tmpdir(), "codex-devspace-logs-"));
    const directory = join(project, ".devspace", "logs");
    await mkdir(join(project, ".devspace"));
    await mkdir(directory);
    await writeFile(join(directory, "default.log"), `${"old line\n".repeat(10_000)}\u001b[32mrecent line\u001b[0m\n`);
    expect(await listDevspaceLogs(project)).toEqual(["default.log"]);
    expect((await tailDevspaceLog(project, "default.log")).at(-1)).toBe("recent line");
    await expect(tailDevspaceLog(project, "../devspace.yaml")).rejects.toThrow("indisponivel");
  });

  test.skipIf(process.platform !== "linux")("reads only the selected project's pods and live proxy", async () => {
    const project = await mkdtemp(join(tmpdir(), "codex-devspace-observe-"));
    const bin = join(project, "bin");
    await mkdir(bin);
    await mkdir(join(project, ".devspace"));
    await mkdir(join(project, "infra"));
    await mkdir(join(project, "infra", "dokploy"));
    await writeFile(join(project, "infra", "dokploy", "versions.tf"), 'source = "j0bit/dokploy"\n');
    await writeFile(join(project, "devspace.yaml"), "version: v2beta1\nname: example\ndev:\n  api:\n    labelSelector:\n      app.kubernetes.io/name: example\n");
    await writeFile(join(project, ".devspace", "cache.yaml"), "lastContext:\n  context: test-cluster\n  namespace: sandbox\n");
    await writeFile(join(project, "Caddyfile"), "http://api.example.localhost {\n reverse_proxy api:3000\n}\n");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const pod = { metadata: { name: "api-abc", labels: { "app.kubernetes.io/component": "api", "app.kubernetes.io/name": "example" }, creationTimestamp: "2026-01-01T00:00:00Z" },
      spec: { nodeName: "node-1", containers: [{ name: "api", image: "ghcr.io/example/api:dev", readinessProbe: { httpGet: { path: "/health" } } }] },
      status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }], containerStatuses: [{ name: "api", ready: true, restartCount: 2,
        state: { running: { startedAt: "2026-01-01T00:00:30Z" } }, lastState: { terminated: { finishedAt: "2026-01-01T00:00:00Z", reason: "Error", exitCode: 1 } } }] } };
    const service = { metadata: { name: "api", labels: { "app.kubernetes.io/component": "api" } }, spec: { selector: { "app.kubernetes.io/component": "api" }, ports: [{ name: "http", port: 3000 }] } };
    const kubectl = join(bin, "kubectl");
    await writeFile(kubectl, `#!/bin/sh
case "$*" in
  *"get pods"*) printf '%s\\n' '${JSON.stringify({ items: [pod] })}' ;;
  *"get services"*) printf '%s\\n' '${JSON.stringify({ items: [service] })}' ;;
  *"get ingresses"*) printf '%s\\n' '{"items":[]}' ;;
  *"get nodes"*) printf '%s\\n' '{"items":[{"metadata":{"name":"node-1"},"spec":{"providerID":"kind://docker/example/node-1"}}]}' ;;
  *"get events"*) printf '%s\\n' '${JSON.stringify({ items: [
    { involvedObject: { name: "api-abc" }, lastTimestamp: "2026-01-01T00:01:00Z", type: "Warning", reason: "Unhealthy", message: "Readiness failed" },
    { involvedObject: { name: "unrelated-pod" }, lastTimestamp: "2026-01-01T00:01:00Z", type: "Warning", reason: "Unhealthy", message: "Unrelated" },
  ] })}' ;;
  *"top pods"*) echo 'Metrics API not available' >&2; exit 1 ;;
  *"logs pod/api-abc"*) printf 'container ready\\n' ;;
  *) echo 'Unexpected kubectl call' >&2; exit 1 ;;
esac
`);
    await chmod(kubectl, 0o755);
    const devspace = join(bin, "devspace");
    await writeFile(devspace, `#!/bin/sh\nprintf '[{"port":"${port}:80"}]\\n'\n`);
    await chmod(devspace, 0o755);
    const docker = join(bin, "docker");
    await writeFile(docker, `#!/bin/sh\nprintf '%s\\n' '{"CPUPerc":"32.50%","MemPerc":"12.5%","MemUsage":"1GiB / 8GiB","NetIO":"2MB / 1MB"}'\n`);
    await chmod(docker, 0o755);
    process.env["PATH"] = `${bin}:${originalPath ?? ""}`;
    try {
      const result = await inspectProject(project, process.pid);
      expect(result).toMatchObject({ name: "example", context: "test-cluster", namespace: "sandbox", metrics: "unavailable" });
      expect(result.hostMetrics).toMatchObject({ node: "node-1", cpu: "32.50%", memory: "1GiB / 8GiB", memoryPercent: "12.5%" });
      expect(result.pods).toMatchObject([{ name: "api-abc", ready: 1, total: 1, restarts: 2 }]);
      expect(result.services).toMatchObject([{ name: "api", ports: ["http:3000"] }]);
      expect(result.providers).toMatchObject([{ component: "api", nodeProvider: "Kind / Docker", registries: ["ghcr.io"] }]);
      expect(result.declaredProductionProvider).toContain("Dokploy / Terraform");
      expect(result.links.map((item) => item.url)).toContain(`http://api.example.localhost:${port}/`);
      expect((await inspectProject(project, null)).links).toEqual([]);
      expect(routeEdges(result)).toEqual([{ service: "api", pod: "api" }]);
      expect(summarizeHealth(result, Date.parse("2026-01-01T00:12:00Z")).state).toBe("healthy");
      expect(summarizeHealth(result, Date.parse("2026-01-01T00:02:00Z")).state).toBe("degraded");
      expect((await timeline(result)).map((item) => item.pod)).toEqual(["api-abc", "api-abc"]);
      expect(await podLogs(result, "api-abc", "api")).toEqual(["container ready"]);
      await expect(podLogs(result, "other-project", "api")).rejects.toThrow("fora do projeto");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test.skipIf(process.platform !== "linux")("recognizes another local session without taking ownership", async () => {
    const project = await mkdtemp(join(tmpdir(), "codex-devspace-external-"));
    await writeFile(join(project, "devspace.yaml"), "version: v2beta1\n");
    const child = spawn("node", ["-e", "process.title = 'devspace dev --no-colors'; process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], {
      cwd: project,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const manager = new DevSpaceManager();
    try {
      await once(child.stdout!, "data");
      const status = await manager.status(project);
      expect(status).toMatchObject({ state: "external", pid: child.pid, logs: [] });
      expect((await manager.start(project)).state).toBe("external");
      expect((await manager.stop(project)).state).toBe("external");
      expect((await manager.restart(project)).state).toBe("external");
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill("SIGTERM");
      await once(child, "exit");
      await manager.shutdown();
    }
    expect((await manager.status(project)).state).toBe("stopped");
  });

  test("discovers, starts, reports links and logs, then stops a session", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-devspace-test-"));
    const project = join(root, "sample");
    const bin = join(root, "bin");
    await mkdir(project);
    await mkdir(bin);
    await writeFile(join(project, "devspace.yaml"), "version: v2beta1\ndev:\n  caddy:\n    ports:\n      - port: '8080:80'\n");
    await writeFile(join(project, "Caddyfile"), "http://api.test.localhost {\n reverse_proxy api:3000\n}\n");
    const executable = join(bin, "devspace");
    await writeFile(executable, `#!/bin/sh
if [ "$1" = "list" ]; then
  printf '{"forwards":[{"localPort":4321}]}\\n'
  exit 0
fi
printf 'Ready at http://localhost:3210\\n'
trap 'exit 0' INT TERM
while true; do sleep 1; done
`);
    await chmod(executable, 0o755);
    process.env["PATH"] = `${bin}:${originalPath ?? ""}`;

    expect(await discoverProjects([root], 2)).toEqual([{ name: "sample", directory: project, configFile: "devspace.yaml" }]);
    const manager = new DevSpaceManager();
    managers.push(manager);
    expect((await manager.start(project)).state).toBe("starting");
    await Bun.sleep(100);
    const running = await manager.status(project);
    expect(running.state).toBe("running");
    expect(running.links).toEqual(["http://api.test.localhost:8080/"]);
    expect(running.logs).toContain("Ready at http://localhost:3210");
    expect((await manager.stop(project)).state).toBe("stopped");
  });
});
