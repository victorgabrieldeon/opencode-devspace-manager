import { describe, expect, test } from "bun:test";
import { extractCaddySiteUrls, extractHttpUrls, extractLocalPorts, extractPortForwards, resolveCaddyUrls } from "../src/discovery.js";

describe("DevSpace discovery", () => {
  test("extracts HTTP links, forwarded ports, and Caddy hosts", () => {
    expect(extractHttpUrls("Open http://localhost:3000, then https://app.test/path.")).toEqual([
      "http://localhost:3000/",
      "https://app.test/path",
    ]);
    expect(extractLocalPorts({ ports: [{ localPort: 3000 }, { local_port: "8080" }, { remotePort: 80 }] })).toEqual([3000, 8080]);
    expect(resolveCaddyUrls(
      extractCaddySiteUrls("http://api.test.localhost {\n reverse_proxy api:3000\n}"),
      extractPortForwards("ports:\n - port: '8080:80'"),
    )).toEqual(["http://api.test.localhost:8080/"]);
  });
});
