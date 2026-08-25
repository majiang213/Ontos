// 工作空间注册表：一个空间一行，只登记身份（画布内容全在 onto_version 的工作行）。

import { ConcernStore } from "./base";

export class WorkspacesStore extends ConcernStore {
  async listWorkspaces(): Promise<string[]> {
    const rows = await this.backend.all(`SELECT name FROM onto_workspace ORDER BY name`);
    const names = rows.map((r) => r.name as string);
    return names.includes("default") ? names : ["default", ...names];
  }

  /** 注册（若不存在）并插入 v1 快照。返回该空间的 id。
   *  并发注册同名空间：两行 insert 都走 insert-ignore（撞 UNIQUE 的败者无害），与 wsId 同一条纪律（基座 runInsertIgnore）。 */
  async ensureWorkspace(name: string, seedYaml: string, seedFrom = "template"): Promise<number> {
    const existing = await this.backend.get(`SELECT id FROM onto_workspace WHERE name = ?`, [name]);
    if (existing) return existing.id as number;
    await this.runInsertIgnore(`onto_workspace (name, seed_from) VALUES (?, ?)`, [name, seedFrom]);
    const row = await this.backend.get(`SELECT id FROM onto_workspace WHERE name = ?`, [name]);
    const id = row!.id as number;
    await this.runInsertIgnore(`onto_version (workspace_id, version, yaml, origin) VALUES (?, 1, ?, 'publish')`, [id, seedYaml]);
    return id;
  }
}
