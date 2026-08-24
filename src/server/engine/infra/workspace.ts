// 工作空间 —— 共享元库 + workspace_id（B 方案）。注册表是 onto_workspace 表；
// src/server/config/ontology.yaml 只当新建空间的种子模板。结构见 MVP 设计文档「工作空间」节。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { metaStore } from "../../meta/store";
import { runtime } from "../../runtime";
import { WsReject } from "../../errors";

export const DEFAULT_WS = "default";

/** 测试工作空间：演示模板与四个 fixture 连接只属于它。填充按空间名判断，与是否配置 LLM Key 无关。 */
export const TEST_WS = "test";
const NAME_RE = /^[a-z][a-z0-9_-]*$/;

export function isWsName(name: string): boolean {
  return NAME_RE.test(name);
}

/** 空间的 v1 种子：test 用演示模板；其余空间（含 default）空白起步（空本体）——切换空间要看得出是另一套。 */
export function seedYamlFor(ws: string): string {
  if (ws === TEST_WS) return readFileSync(join(runtime().cwd, "src/server/config/ontology.yaml"), "utf8");
  return "object_types: {}\n";
}

export async function listWorkspaces(): Promise<string[]> {
  const names = await metaStore().listWorkspaces();
  return names.includes(TEST_WS) ? names : [...names, TEST_WS]; // test 常驻列表，首次访问才真正注册（latestVersion 播种）
}

/** 注册（若不存在）并把种子插成该空间的 v1。 */
export function ensureWorkspace(ws: string): Promise<number> {
  if (!isWsName(ws)) throw new WsReject(`空间名不合法：${ws}`);
  return metaStore().ensureWorkspace(ws, seedYamlFor(ws));
}

/** 新建空间（空白起步：空本体、无连接，从连接数据源开始玩）。 */
export async function createWorkspace(name: string): Promise<void> {
  if (!isWsName(name)) throw new WsReject(`空间名必须是小写字母/数字/中划线/下划线，字母开头：${name}`);
  if ((await metaStore().listWorkspaces()).includes(name)) throw new WsReject(`空间已存在：${name}`);
  await metaStore().ensureWorkspace(name, seedYamlFor(name));
}
