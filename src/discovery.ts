const URL_PATTERN = /https?:\/\/[^\s<>'"`]+/giu;
const LOCAL_PORT_KEYS = new Set(["localport", "local_port", "local"]);

export type PortForward = {
  readonly localPort: number;
  readonly targetPort: number;
};

export function extractHttpUrls(text: string): readonly string[] {
  const urls = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    const value = match[0].replace(/[),.;\]}]+$/u, "");
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") urls.add(url.toString());
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  return [...urls];
}

export function extractLocalPorts(value: unknown): readonly number[] {
  const ports = new Set<number>();
  visit(value, null, ports);
  return [...ports].sort((left, right) => left - right);
}

export function extractCaddySiteUrls(text: string): readonly string[] {
  const urls = new Set<string>();
  for (const line of text.split(/\r?\n/u)) {
    const header = line.split("#", 1)[0]?.split("{", 1)[0]?.trim();
    if (!header || !line.includes("{")) continue;
    for (const value of header.split(/[\s,]+/u)) {
      try {
        const url = new URL(value);
        if (url.protocol === "http:" || url.protocol === "https:") urls.add(url.toString());
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
    }
  }
  return [...urls].sort();
}

export function extractPortForwards(text: string): readonly PortForward[] {
  const forwards = new Map<string, PortForward>();
  const normalized = text.replaceAll("\\u003e", ">");
  collectForwards(normalized, /\bport:\s*["']?(\d{1,5})\s*:\s*(\d{1,5})/giu, forwards);
  collectForwards(normalized, /Port forwarding started on:\s*(\d{1,5})\s*(?:-|=)?(?:>|→)\s*(\d{1,5})/giu, forwards);
  return [...forwards.values()].sort((left, right) => left.localPort - right.localPort || left.targetPort - right.targetPort);
}

export function resolveCaddyUrls(siteUrls: readonly string[], forwards: readonly PortForward[]): readonly string[] {
  const urls = new Set<string>();
  for (const value of siteUrls) {
    const url = new URL(value);
    const targetPort = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    const forward = forwards.find((candidate) => candidate.targetPort === targetPort);
    if (forward === undefined) continue;
    url.port = String(forward.localPort);
    urls.add(url.toString());
  }
  return [...urls].sort();
}

function visit(value: unknown, key: string | null, ports: Set<number>): void {
  if (key !== null && LOCAL_PORT_KEYS.has(key.toLowerCase())) {
    const port = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (isPort(port)) ports.add(port);
  }
  if (Array.isArray(value)) {
    for (const item of value) visit(item, null, ports);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey, ports);
}

function collectForwards(text: string, pattern: RegExp, forwards: Map<string, PortForward>): void {
  for (const match of text.matchAll(pattern)) {
    const localPort = Number(match[1]);
    const targetPort = Number(match[2]);
    if (!isPort(localPort) || !isPort(targetPort)) continue;
    forwards.set(`${localPort}:${targetPort}`, { localPort, targetPort });
  }
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 65_535;
}
