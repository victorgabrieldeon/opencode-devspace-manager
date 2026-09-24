---
name: devspace-manager
description: Discover and manage local DevSpace projects from Codex Desktop. Use when the user asks to list DevSpace projects, start, stop, restart, inspect status or logs, find forwarded URLs, or open a DevSpace service.
---

# DevSpace Manager

Use the `devspace_manager` MCP tools. Keep every action scoped to the project directory the user named or the active workspace.

## Workflow

1. If the directory is unclear, call `list_projects`. Prefer the active workspace when it contains `devspace.yaml` or `devspace.yml`; otherwise present discovered matches.
2. Call `status` before `start`, `stop`, or `restart` so the current state and detected config are explicit.
3. Call `start` only when a DevSpace config is detected. Poll `status` once after startup when links or logs are needed.
4. Call `stop` only for sessions controlled by this plugin. Never kill unrelated DevSpace, Kubernetes, Docker, or shell processes.
5. Call `open_url` only when the user explicitly asks to open a returned HTTP or HTTPS link.
6. Report state, config file, PID when present, links, and the last relevant log lines. Keep routine output concise.

## Safety

- Never edit `devspace.yaml`, Kubernetes resources, kubeconfig, or cluster state unless separately requested.
- Treat `stop` and `restart` as interrupting active development work.
- Do not invent project paths or service URLs. Use tool results.
- If startup fails, show the failure message and relevant logs. Do not retry automatically.
