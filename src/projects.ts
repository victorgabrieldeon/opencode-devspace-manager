import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const CONFIG_NAMES = ["devspace.yaml", "devspace.yml"] as const;
const SKIPPED_DIRECTORIES = new Set([".git", ".idea", ".next", ".turbo", "dist", "node_modules", "target"]);

export type DevSpaceProject = {
  readonly name: string;
  readonly directory: string;
  readonly configFile: string;
};

export async function discoverProjects(roots: readonly string[] = [join(homedir(), "code")], maxDepth = 4): Promise<readonly DevSpaceProject[]> {
  const projects = new Map<string, DevSpaceProject>();
  await Promise.all(roots.map((root) => scan(resolve(root), 0, maxDepth, projects)));
  return [...projects.values()].sort((left, right) => left.name.localeCompare(right.name) || left.directory.localeCompare(right.directory));
}

async function scan(directory: string, depth: number, maxDepth: number, projects: Map<string, DevSpaceProject>): Promise<void> {
  const entries = await readDirectory(directory);
  if (entries === null) return;
  const config = CONFIG_NAMES.find((name) => entries.some((entry) => entry.isFile() && entry.name === name));
  if (config !== undefined) {
    projects.set(directory, { name: basename(directory), directory, configFile: config });
    return;
  }
  if (depth >= maxDepth) return;
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name))
    .map((entry) => scan(join(directory, entry.name), depth + 1, maxDepth, projects)));
}

async function readDirectory(directory: string): Promise<Dirent<string>[] | null> {
  try {
    return await readdir(directory, { encoding: "utf8", withFileTypes: true });
  } catch (error) {
    if (isMissingOrDenied(error)) return null;
    throw error;
  }
}

function isMissingOrDenied(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "EACCES");
}
