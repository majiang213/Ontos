// 工作空间 —— 共享元库 + workspace_id（B 方案）。注册表是 onto_workspace 表；
// src/server/config/ontology.yaml 只当新建空间的种子模板。结构见 MVP 设计文档「工作空间」节。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { metaStore } from "../meta/store";

export const DEFAULT_WS = "default";
const NAME_RE = /^[a-z][a-z0-9_-]*$/;

export function isWsName(name: string): boolean {
  return NAME_RE.test(name);
}

/** 空间的 v1 种子：default 用演示模板；其余空间空白起步（空本体）——切换空间要看得出是另一套。 */
export function seedYamlFor(ws: string): string {
  if (ws === DEFAULT_WS) return readFileSync(join(process.cwd(), "src/server/config/ontology.yaml"), "utf8");
  return "object_types: {}\n";
}

export function listWorkspaces(): Promise<string[]> {
  return metaStore().listWorkspaces();
}

/** 注册（若不存在）并把种子插成该空间的 v1。 */
export function ensureWorkspace(ws: string): Promise<number> {
  if (!isWsName(ws)) throw new Error(`空间名不合法：${ws}`);
  return metaStore().ensureWorkspace(ws, seedYamlFor(ws));
}

/** 新建空间（空白起步：空本体、无连接，从连接数据源开始玩）。 */
export async function createWorkspace(name: string): Promise<void> {
  if (!isWsName(name)) throw new Error(`空间名必须是小写字母/数字/中划线/下划线，字母开头：${name}`);
  if ((await metaStore().listWorkspaces()).includes(name)) throw new Error(`空间已存在：${name}`);
  await metaStore().ensureWorkspace(name, seedYamlFor(name));
}
