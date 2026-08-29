// 工作空间注册表：一个空间一行，只登记身份（画布内容全在 onto_version 的工作行）。

import { ConcernStore } from "./base";

export class WorkspacesStore extends ConcernStore {
  async listWorkspaces(): Promise<string[]> {
    const rows = await this.datasource.all(`SELECT name FROM onto_workspace ORDER BY name`);
    const names = rows.map((r) => r.name as string);
    return names.includes("default") ? names : ["default", ...names];
  }

  /** 注册（若不存在）。注册只落空间行——不产生已发布版本（首版由人发布）；演示模板的 v1 由调用方对 test 显式发布。
   *  并发注册同名空间：insert-ignore（撞 UNIQUE 的败者无害），与 wsId 同一条纪律（基座 runInsertIgnore）。 */
  async ensureWorkspace(name: string, seedFrom = "template"): Promise<number> {
    const existing = await this.datasource.get(`SELECT id FROM onto_workspace WHERE name = ?`, [name]);
    if (existing) return existing.id as number;
    await this.runInsertIgnore(`onto_workspace (name, seed_from) VALUES (?, ?)`, [name, seedFrom]);
    return (await this.datasource.get(`SELECT id FROM onto_workspace WHERE name = ?`, [name]))!.id as number;
  }
}
