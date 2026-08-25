// 工作空间 —— 共享元库 + workspace_id（B 方案）。注册表是 onto_workspace 表；
// src/server/config/ontology.yaml 只当新建空间的种子模板。结构见 MVP 设计文档「工作空间」节。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { metaStore } from "../meta/store";
import { runtime } from "../runtime";
import { WorkspaceReject, MSG, codeOf, type Result } from "../errors";

export const DEFAULT_WORKSPACE = "default";

/** 测试工作空间：演示模板与四个 fixture 连接只属于它。填充按空间名判断，与是否配置 LLM Key 无关。 */
export const TEST_WORKSPACE = "test";
/** 空间名形状：比 schema/ops 的 NAME_RE 多许中划线（两种纪律，名字区分开，别混用）。 */
const WORKSPACE_NAME_RE = /^[a-z][a-z0-9_-]*$/;

export function isWorkspaceName(name: string): boolean {
  return WORKSPACE_NAME_RE.test(name);
}

/** 空间的 v1 种子：test 用演示模板；其余空间（含 default）空白起步（空本体）——切换空间要看得出是另一套。 */
export function seedYamlFor(workspace: string): string {
  if (workspace === TEST_WORKSPACE) return readFileSync(join(runtime().cwd, "src/server/config/ontology.yaml"), "utf8");
  return "object_types: {}\n";
}

export async function listWorkspaces(): Promise<Result<string[]>> {
  try {
    const names = await metaStore().listWorkspaces();
    const value = names.includes(TEST_WORKSPACE) ? names : [...names, TEST_WORKSPACE]; // test 常驻列表，首次访问才真正注册（latestVersion 播种）
    return { code: 200, message: MSG.resultWorkspaces(value.length), value };
  } catch (e) {
    const code = codeOf(e);
    if (code !== null) return { code, message: e instanceof Error ? e.message : String(e) };
    throw e;
  }
}

/** 注册（若不存在）并把种子插成该空间的 v1。 */
export function ensureWorkspace(workspace: string): Promise<number> {
  if (!isWorkspaceName(workspace)) throw new WorkspaceReject(MSG.workspaceNameBad(workspace));
  return metaStore().ensureWorkspace(workspace, seedYamlFor(workspace));
}

/** 新建空间（空白起步：空本体、无连接，从连接数据源开始玩）。 */
export async function createWorkspace(name: string): Promise<Result<void>> {
  try {
    if (!isWorkspaceName(name)) throw new WorkspaceReject(MSG.workspaceNameBad(name));
    if ((await metaStore().listWorkspaces()).includes(name)) throw new WorkspaceReject(MSG.workspaceExists(name));
    await metaStore().ensureWorkspace(name, seedYamlFor(name));
    return { code: 200, message: MSG.resultWorkspaceCreated(name), value: undefined };
  } catch (e) {
    const code = codeOf(e);
    if (code !== null) return { code, message: e instanceof Error ? e.message : String(e) };
    throw e;
  }
}
