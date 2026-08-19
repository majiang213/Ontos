// 工作空间 —— 一个空间一套独立配置与元数据：lib/config/workspaces/<name>/ 下
// 各自的 ontology.yaml、versions/、ontos-meta.db、canvas-layout.json。
// 仓库根的 lib/config/ontology.yaml 只当新建空间的种子模板；默认空间 default 首次访问自动复制。

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_WS = "default";
const NAME_RE = /^[a-z][a-z0-9_-]*$/;

const rootDir = () => join(process.cwd(), "lib/config");
const workspacesDir = () => join(rootDir(), "workspaces");
const seedTemplate = () => join(rootDir(), "ontology.yaml");

/** 空间目录（不保证存在；存在性走 ensureWorkspace）。 */
export function wsDir(ws: string): string {
  return join(workspacesDir(), ws);
}

export function isWsName(name: string): boolean {
  return NAME_RE.test(name);
}

export function listWorkspaces(): string[] {
  if (!existsSync(workspacesDir())) return [DEFAULT_WS];
  const dirs = readdirSync(workspacesDir(), { withFileTypes: true })
    .filter((d) => d.isDirectory() && isWsName(d.name))
    .map((d) => d.name)
    .sort();
  return dirs.includes(DEFAULT_WS) ? dirs : [DEFAULT_WS, ...dirs];
}

/** 确保空间存在：没有就从种子模板复制出 ontology.yaml（其余文件随用随建）。返回空间目录。 */
export function ensureWorkspace(ws: string): string {
  if (!isWsName(ws)) throw new Error(`空间名不合法：${ws}`);
  const dir = wsDir(ws);
  const seed = join(dir, "ontology.yaml");
  if (!existsSync(seed)) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(seedTemplate(), seed);
  }
  return dir;
}

/** 新建空间（从种子模板起步）。 */
export function createWorkspace(name: string): void {
  if (!isWsName(name)) throw new Error(`空间名必须是小写字母/数字/中划线/下划线，字母开头：${name}`);
  if (existsSync(wsDir(name))) throw new Error(`空间已存在：${name}`);
  ensureWorkspace(name);
}
