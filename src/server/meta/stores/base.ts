// 关切 store 的基座：共享后端与「空间名 → workspace_id」的注册纪律（未注册的先注册）。
// 注册不产生已发布版本（首版由人发布）；无发布时 latestVersion 回退种子（version 0），不落库。

import type { MetaDatasource, DatasourceDialect } from "../datasource";

/** insert-ignore 的 SQL 形态（方言判断唯一出处）：mysql 用 INSERT IGNORE，pg 用 ON CONFLICT DO NOTHING，sqlite 用 INSERT OR IGNORE。 */
export function insertIgnoreSql(dialect: DatasourceDialect, into: string): string {
  if (dialect === "mysql") return `INSERT IGNORE INTO ${into}`;
  if (dialect === "pg") return `INSERT INTO ${into} ON CONFLICT DO NOTHING`;
  return `INSERT OR IGNORE INTO ${into}`;
}

/** 方言 upsert（唯一出处）：mysql 用 ON DUPLICATE KEY UPDATE col=VALUES(col)，pg/sqlite 用 ON CONFLICT(keys) DO UPDATE SET col=excluded.col。
 *  touchUpdatedAt=true 追加 updated_at 刷新（mysql/pg 用 CURRENT_TIMESTAMP，sqlite 用 datetime('now')）。 */
export function upsertSql(
  dialect: DatasourceDialect,
  table: string,
  columns: string[],
  conflict: string[],
  update: string[],
  touchUpdatedAt = false
): string {
  const cols = `(${columns.join(", ")})`;
  const qs = `(${columns.map(() => "?").join(", ")})`;
  if (dialect === "mysql") {
    const set = update.map((c) => `${c}=VALUES(${c})`);
    if (touchUpdatedAt) set.push("updated_at=CURRENT_TIMESTAMP");
    return `INSERT INTO ${table} ${cols} VALUES ${qs} ON DUPLICATE KEY UPDATE ${set.join(", ")}`;
  }
  const set = update.map((c) => `${c}=excluded.${c}`);
  if (touchUpdatedAt) set.push(`updated_at=${dialect === "sqlite" ? "datetime('now')" : "CURRENT_TIMESTAMP"}`);
  return `INSERT INTO ${table} ${cols} VALUES ${qs} ON CONFLICT(${conflict.join(", ")}) DO UPDATE SET ${set.join(", ")}`;
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
