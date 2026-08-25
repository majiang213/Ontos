// SQLite 驱动 —— 每个连接一个 node:sqlite 库（内存或文件），用真实 SQL 执行下推与写回。
// 真驱动聚一处（pool 家族在 sqlDriver.ts）：本类只管驱动，不背演示机器——
// 用户接入的 sqlite 文件库走本类（connections.ts registerSaved）；演示种子/列注释在 fixture.ts（继承本类），问数剧本在 llm/canned.ts。

import { DatabaseSync } from "node:sqlite";
import { buildInsert, buildSelect, buildStatement, maskValue, type Condition, type SourceDriver, type TableInfo } from "./driver";
import { EngineReject, MSG } from "../../errors";

// node:sqlite 的参数类型是 SQLInputValue；引擎产出的 unknown[] 在这一处收口断言。
// node:sqlite 不认 boolean，绑定前归一成 1/0。
const bind = (params: unknown[]) => params.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v)) as never[];

export class SqliteDriver implements SourceDriver {
  readonly dialect: "sqlite" | "mysql" | "pg" = "sqlite"; // 测试可覆写模拟他种方言的写回行为
  protected dbs = new Map<string, DatabaseSync>();

  /** 注册一个连接，返回它的内存库（建表、插种子用）。同名覆盖先关旧句柄。 */
  register(connection: string): DatabaseSync {
    this.dbs.get(connection)?.close();
    const db = new DatabaseSync(":memory:");
    this.dbs.set(connection, db);
    return db;
  }

  /** 注册一个 SQLite 文件库作为连接（连接表单里的 sqlite 类型走这里）。同名覆盖先关旧句柄。 */
  registerFile(connection: string, path: string): void {
    this.dbs.get(connection)?.close();
    this.dbs.set(connection, new DatabaseSync(path));
  }

  protected db(connection: string): DatabaseSync {
    const db = this.dbs.get(connection);
    if (!db) throw new EngineReject(MSG.connectionUnregistered(connection));
    return db;
  }

  async select(connection: string, table: string, columns: string[], conditions: Condition[], limit?: number) {
    const { sql, params } = buildSelect(table, columns, conditions, "sqlite", limit);
    return this.db(connection).prepare(sql).all(...bind(params)) as Record<string, unknown>[];
  }

  async insert(connection: string, table: string, row: Record<string, unknown>) {
    const { sql, params } = buildInsert("sqlite", table, row);
    this.db(connection).prepare(sql).run(...bind(params));
  }

  async update(connection: string, table: string, set: Record<string, unknown>, conditions: Condition[]): Promise<number> {
    const { sql, params } = buildStatement("sqlite", "update", table, { set, conditions });
    const res = this.db(connection).prepare(sql).run(...bind(params));
    return Number(res.changes);
  }

  async delete(connection: string, table: string, conditions: Condition[]): Promise<number> {
    const { sql, params } = buildStatement("sqlite", "delete", table, { conditions });
    const res = this.db(connection).prepare(sql).run(...bind(params));
    return Number(res.changes);
  }

  async sample(connection: string, table: string, limit = 3) {
    const { sql, params } = buildSelect(table, [], [], "sqlite", limit);
    const rows = this.db(connection).prepare(sql).all(...bind(params)) as Record<string, unknown>[];
    return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, maskValue(k, v)])));
  }

  /** 释放全部库句柄（删连接、测试收尾用）。 */
  async close(): Promise<void> {
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
  }

  /** 连接清单（注册表把内置连接逐个挂进来时用）。 */
  connections(): string[] {
    return [...this.dbs.keys()];
  }

  async introspect(connection: string): Promise<TableInfo[]> {
    const db = this.db(connection);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[];
    return tables.map((t) => ({
      name: t.name,
      columns: (db.prepare(`PRAGMA table_info("${t.name}")`).all() as { name: string; type: string; pk: number }[]).map((c) => ({
        name: c.name,
        type: c.type,
        pk: c.pk === 1,
      })),
    }));
  }
}
