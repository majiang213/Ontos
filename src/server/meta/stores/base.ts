// 关切 store 的基座：共享后端与「空间名 → workspace_id」的注册纪律（未注册的先注册）。
// 版本行由 latestVersion 播种——元数据写（留痕/连接/问题集）可能先于配置访问碰到新空间。

import type { MetaDatasource, DatasourceDialect } from "../datasource";

/** insert-ignore 的 SQL 形态（方言判断唯一出处）：mysql 用 INSERT IGNORE，pg 用 ON CONFLICT DO NOTHING，sqlite 用 INSERT OR IGNORE。 */
export function insertIgnoreSql(dialect: DatasourceDialect, into: string): string {
  if (dialect === "mysql") return `INSERT IGNORE INTO ${into}`;
  if (dialect === "pg") return `INSERT INTO ${into} ON CONFLICT DO NOTHING`;
  return `INSERT OR IGNORE INTO ${into}`;
}

export abstract class ConcernStore {
  constructor(protected datasource: MetaDatasource) {}

  /** insert-ignore：并发首写撞 UNIQUE 时败者无害，调用方再 SELECT 拿赢家的行。
   *  sql 写 INTO 之后的部分（表、列、值）。 */
  protected async runInsertIgnore(sql: string, params: unknown[]): Promise<void> {
    await this.datasource.run(insertIgnoreSql(this.datasource.dialect, sql), params);
  }

  /** 空间 id；未注册的先注册。并发首写同一空间（如留痕与发号同时到达）SELECT 都 miss 后裸 INSERT 会撞
   *  onto_workspace.name 的 UNIQUE——insert-ignore 让败者无害，再 SELECT 拿赢家的 id。 */
  protected async wsId(workspace: string): Promise<number> {
    const row = await this.datasource.get(`SELECT id FROM onto_workspace WHERE name = ?`, [workspace]);
    if (row) return row.id as number;
    await this.runInsertIgnore(`onto_workspace (name, seed_from) VALUES (?, ?)`, [workspace, "lazy"]);
    return (await this.datasource.get(`SELECT id FROM onto_workspace WHERE name = ?`, [workspace]))!.id as number;
  }
}
