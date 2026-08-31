// SQLite 驱动 —— 每个连接一个 node:sqlite 库（内存或文件），用真实 SQL 执行下推与写回。
// 真驱动聚一处（pool 家族在 sqlDriver.ts）：本类管驱动 + 列注释（SQLite 本身没有列注释，
// 文件连接经 ${db}.comments.json sidecar 载入；种子注释由 fixture.ts 经 setComments 手写）。
// 用户接入的 sqlite 文件库走本类（connections.ts registerSaved）；演示种子数据在 fixture.ts（继承本类），问数剧本在 llm/demo.ts。

import { DatabaseSync } from "node:sqlite";
import { buildAggregate, buildInsert, buildSelect, buildStatement, maskValue, type AggMetric, type Condition, type SourceDriver, type TableInfo } from "./driver";
import { demoCommentsForFile, readSidecarComments, sidecarPathFor } from "./demoSystems";
import { EngineReject, MSG } from "../errors";

// node:sqlite 的参数类型是 SQLInputValue；引擎产出的 unknown[] 在这一处收口断言。
// node:sqlite 不认 boolean，绑定前归一成 1/0。
const bind = (params: unknown[]) => params.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v)) as never[];

export class SqliteDriver implements SourceDriver {
  readonly dialect: "sqlite" | "mysql" | "pg" = "sqlite"; // 测试可覆写模拟他种方言的写回行为
  protected dbs = new Map<string, DatabaseSync>();
  private comments = new Map<string, Map<string, Record<string, string>>>(); // connection → table → 列名 → 中文注释

  /** 给某张表的列挂中文注释（SQLite 无列注释：文件库由 sidecar 载入，演示种子手写）。 */
  setComments(connection: string, table: string, map: Record<string, string>): void {
    const perTable = this.comments.get(connection) ?? new Map<string, Record<string, string>>();
    perTable.set(table, map);
    this.comments.set(connection, perTable);
  }

  /** 注册一个连接，返回它的内存库（建表、插种子用）。同名覆盖先关旧句柄。 */
  register(connection: string): DatabaseSync {
    this.dbs.get(connection)?.close();
    const db = new DatabaseSync(":memory:");
    this.dbs.set(connection, db);
    return db;
  }

  /** 注册一个 SQLite 文件库作为连接（sqlite 文件类型连接走这里）。同名覆盖先关旧句柄。
   *  打开后尽力载入列注释，sidecar 永不抛错（与缺文件跳过同一条纪律：一份坏 JSON 不许拖垮整份注册表）：
   *  sidecar 合法 → 按表挂注释；损坏 → 只警告不加注释（不回退种子注释盖住坏文件）；不存在 → 按库文件名回退种子注释。 */
  registerFile(connection: string, path: string): void {
    this.dbs.get(connection)?.close();
    this.comments.delete(connection);
    this.dbs.set(connection, new DatabaseSync(path));
    try {
      const sidecar = readSidecarComments(path);
      if (sidecar.kind === "corrupt") {
        console.warn(`[ontos] 演示注释文件读不出（${sidecarPathFor(path)}），连接 ${connection} 不带列注释`);
        return;
      }
      const comments = sidecar.kind === "ok" ? sidecar.comments : demoCommentsForFile(path);
      for (const [table, map] of Object.entries(comments ?? {})) this.setComments(connection, table, map);
    } catch (e) {
      console.warn(`[ontos] 列注释加载失败（${path}）：${e instanceof Error ? e.message : String(e)}`);
    }
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

  async selectAggregate(connection: string, table: string, group: { column: string; as: string }[], metrics: AggMetric[], conditions: Condition[]) {
    const { sql, params } = buildAggregate(table, group, metrics, conditions, "sqlite");
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

  /** 内省叠加列注释与唯一约束（注释不住库里的表：sidecar / setComments 手写，sqlite_master 里永远没有注释表；
   *  唯一性走 PRAGMA index_list/index_info：单列唯一索引才证明该列唯一，复合唯一索引的单列不唯一，部分索引不保证全局唯一）。 */
  async introspect(connection: string): Promise<TableInfo[]> {
    const db = this.db(connection);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[];
    return tables.map((t) => {
      const uniqueCols = new Set<string>();
      for (const idx of db.prepare(`PRAGMA index_list("${t.name}")`).all() as { name: string; unique: number; partial: number }[]) {
        if (!idx.unique || idx.partial) continue;
        const cols = db.prepare(`PRAGMA index_info("${idx.name}")`).all() as { name: string | null }[];
        if (cols.length === 1 && cols[0].name) uniqueCols.add(cols[0].name);
      }
      return {
        name: t.name,
        columns: (db.prepare(`PRAGMA table_info("${t.name}")`).all() as { name: string; type: string; pk: number }[]).map((c) => {
          const col: TableInfo["columns"][number] = { name: c.name, type: c.type, pk: c.pk === 1, ...(uniqueCols.has(c.name) ? { unique: true } : {}) };
          const comment = this.comments.get(connection)?.get(t.name)?.[c.name];
          return comment ? { ...col, comment } : col;
        }),
      };
    });
  }
}
