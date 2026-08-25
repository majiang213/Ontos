// 关切 store 的基座：共享后端与「空间名 → workspace_id」的注册纪律（未注册的先注册）。
// 版本行由 latestVersion 播种——元数据写（留痕/连接/问题集）可能先于配置访问碰到新空间。

import type { MetaBackend } from "../backends";

export abstract class ConcernStore {
  constructor(protected backend: MetaBackend) {}

  /** insert-ignore（方言判断唯一出处）：并发首写撞 UNIQUE 时败者无害，调用方再 SELECT 拿赢家的行。
   *  sql 写 INTO 之后的部分（表、列、值）。 */
  protected async runInsertIgnore(sql: string, params: unknown[]): Promise<void> {
    const ignore = this.backend.dialect === "mysql" ? "INSERT IGNORE" : "INSERT OR IGNORE";
    await this.backend.run(`${ignore} INTO ${sql}`, params);
  }

  /** 空间 id；未注册的先注册。并发首写同一空间（如留痕与发号同时到达）SELECT 都 miss 后裸 INSERT 会撞
   *  onto_workspace.name 的 UNIQUE——insert-ignore 让败者无害，再 SELECT 拿赢家的 id。 */
  protected async wsId(workspace: string): Promise<number> {
    const row = await this.backend.get(`SELECT id FROM onto_workspace WHERE name = ?`, [workspace]);
    if (row) return row.id as number;
    await this.runInsertIgnore(`onto_workspace (name, seed_from) VALUES (?, ?)`, [workspace, "lazy"]);
    return (await this.backend.get(`SELECT id FROM onto_workspace WHERE name = ?`, [workspace]))!.id as number;
  }
}
