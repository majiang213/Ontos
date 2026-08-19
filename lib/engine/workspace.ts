// 工作空间 —— 共享元库 + workspace_id（B 方案）。注册表是 onto_workspace 表；
// lib/config/ontology.yaml 只当新建空间的种子模板。结构见 MVP 设计文档「工作空间」节。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { metaStore } from "../meta/store";

export const DEFAULT_WS = "default";
const NAME_RE = /^[a-z][a-z0-9_-]*$/;

export function isWsName(name: string): boolean {
  return NAME_RE.test(name);
}

/** 种子模板内容（新建空间的 v1）。 */
function seedYaml(): string {
  return readFileSync(join(process.cwd(), "lib/config/ontology.yaml"), "utf8");
}

export function listWorkspaces(): Promise<string[]> {
  return metaStore().listWorkspaces();
}

/** 注册（若不存在）并把种子模板插成该空间的 v1。 */
export function ensureWorkspace(ws: string): Promise<number> {
  if (!isWsName(ws)) throw new Error(`空间名不合法：${ws}`);
  return metaStore().ensureWorkspace(ws, seedYaml());
}

/** 新建空间（从种子模板起步）。 */
export async function createWorkspace(name: string): Promise<void> {
  if (!isWsName(name)) throw new Error(`空间名必须是小写字母/数字/中划线/下划线，字母开头：${name}`);
  if ((await metaStore().listWorkspaces()).includes(name)) throw new Error(`空间已存在：${name}`);
  await metaStore().ensureWorkspace(name, seedYaml());
}
