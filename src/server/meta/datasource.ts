// 元库数据库 —— 共享库 + workspace_id（B 方案）。库可换：
//   离线开发：单文件 SQLite（ONTOS_META_DSN 不设，即开即用；隔离在列上不在文件上）
//   生产：ONTOS_META_DSN=mysql://… 走 MySQL；postgres://… / postgresql://… 走 PostgreSQL
// DDL 一种数据库一个文件（./ddl/sqlite.sql、mysql.sql、pg.sql 同构手写）；开发期不做存量迁移——结构变了删库重建，
// 启动只跑各文件的 CREATE TABLE IF NOT EXISTS。
// workspace_id 的过滤纪律收在各关切 store：方法第一个参数就是空间名，调用方不碰 SQL。
// 方言选择的唯一出处是 metaDialectOf（DSN scheme → sqlite | mysql | pg）。

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import mysql from "mysql2/promise";
import pg from "pg";
import { MSG } from "../errors";

export type DatasourceDialect = "sqlite" | "mysql" | "pg";

/** 读方言 DDL 文件（与 cwd 下默认元库文件同一取径纪律，见 store.ts 的 sqlitePath 拼法）。 */
export function ddlOf(dialect: DatasourceDialect): string {
  return readFileSync(join(process.cwd(), "src/server/meta/ddl", `${dialect}.sql`), "utf8");
}

/* ---------- 方言实现 ---------- */

export interface MetaDatasource {
  readonly dialect: DatasourceDialect;
  all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  get(sql: string, params?: unknown[]): Promise<Record<string, unknown> | undefined>;
  /** 执行写语句，返回受影响行数（CAS 依赖：0 行 = 条件不命中 = 冲突）。
   *  方言计数口径不同：SQLite 的 changes 与 PG 的 rowCount 计「命中的行」（值相同也计），MySQL 的 affectedRows 计「值真变的行」。
   *  契约靠调用方的不变量对齐：所有 CAS 写都 bump rev（rev = rev + 1），值必变，三方言都返回 1。 */
  run(sql: string, params?: unknown[]): Promise<number>;
  close(): Promise<void>;
}

/** DSN scheme → 元库方言。不设或空串 = sqlite；未知 scheme 抛 MSG.metaDsnUnknown（只报 scheme，不报整段 DSN，避免把密码带进错误）。 */
export function metaDialectOf(dsn?: string): DatasourceDialect {
  if (!dsn) return "sqlite";
  const cut = dsn.indexOf("://");
  const scheme = cut > 0 ? dsn.slice(0, cut).toLowerCase() : "";
  if (scheme === "mysql") return "mysql";
  if (scheme === "postgres" || scheme === "postgresql") return "pg";
  throw new Error(MSG.metaDsnUnknown(scheme));
}

/** 按 DSN 打开对应库；sqlite 路径由调用方给（运行态 cwd 下的默认文件，或测试临时文件）。 */
export function openMetaDatasource(dsn: string | undefined, sqlitePath: string): MetaDatasource {
  const dialect = metaDialectOf(dsn);
  if (dialect === "sqlite") return new SqliteDatasource(sqlitePath);
  if (dialect === "mysql") return new MysqlDatasource(dsn!);
  return new PgDatasource(dsn!);
}

/** 关切 store 写的是 `?` 占位符（与 sqlite/mysql 同一套 SQL）。PG 侧在发包前换成 $1 $2…。
 *  源驱动另有一份同形（infra/driver.renderPlaceholders）：那边翻的是下推 SQL，这边翻的是元库 SQL，不互相 import。 */
export function toPgPlaceholders(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

export class SqliteDatasource implements MetaDatasource {
  readonly dialect = "sqlite" as const;
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA foreign_keys = ON"); // DDL 声明的 FK 靠这句生效（SQLite 默认不查）；父行先插由 wsId 兜，开启安全
    this.db.exec(ddlOf("sqlite"));
  }

  async all(sql: string, params: unknown[] = []) {
    return this.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  }
  async get(sql: string, params: unknown[] = []) {
    return this.db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined;
  }
  async run(sql: string, params: unknown[] = []) {
    const r = this.db.prepare(sql).run(...(params as never[]));
    return Number(r.changes); // node:sqlite 的 changes 是 number | bigint，统一回 number（CAS 受影响行数）
  }
  async close() {
    this.db.close();
  }
}

export class MysqlDatasource implements MetaDatasource {
  readonly dialect = "mysql" as const;
  private pool: mysql.Pool;
  constructor(dsn: string) {
    // multipleStatements 必须开：mysql.sql 九个 CREATE TABLE 一次下发（不开 mysql2 默认拒多语句，ready 永远 reject）
    this.pool = mysql.createPool({ uri: dsn, connectionLimit: 4, namedPlaceholders: false, multipleStatements: true });
    this.ready = this.pool.query(ddlOf("mysql")).then(() => undefined);
  }
  private ready: Promise<void>;

  async all(sql: string, params: unknown[] = []) {
    await this.ready;
    const [rows] = await this.pool.query(sql, params);
    return rows as Record<string, unknown>[];
  }
  async get(sql: string, params: unknown[] = []) {
    return (await this.all(sql, params))[0];
  }
  async run(sql: string, params: unknown[] = []) {
    await this.ready;
    const [result] = await this.pool.query(sql, params);
    return (result as mysql.ResultSetHeader).affectedRows;
  }
  async close() {
    await this.pool.end();
  }
}

const PG_INT8 = 20;
const PG_TIMESTAMP = 1114;
const PG_TIMESTAMPTZ = 1184;

export function coercePgRow(fields: { name: string; dataTypeID: number }[], row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) {
    const v = out[f.name];
    if (v == null) continue;
    if (f.dataTypeID === PG_INT8) out[f.name] = Number(v); // int8 默认是字符串，元库 id/workspace_id 在 Number 安全范围内
    else if (f.dataTypeID === PG_TIMESTAMP || f.dataTypeID === PG_TIMESTAMPTZ) {
      out[f.name] = v instanceof Date ? v.toISOString() : String(v);
    }
  }
  return out;
}

export class PgDatasource implements MetaDatasource {
  readonly dialect = "pg" as const;
  private pool: pg.Pool;
  private ready: Promise<void>;
  constructor(dsn: string) {
    const p = new pg.Pool({ connectionString: dsn, max: 4 });
    p.on("error", () => {}); // 空闲连接掉线不炸进程（pg 官方要求；与 sqlDriver 同源合同）
    this.pool = p;
    this.ready = p.query(ddlOf("pg")).then(() => undefined);
  }

  async all(sql: string, params: unknown[] = []) {
    await this.ready;
    const r = await this.pool.query(toPgPlaceholders(sql), params);
    return r.rows.map((row) => coercePgRow(r.fields, row as Record<string, unknown>));
  }
  async get(sql: string, params: unknown[] = []) {
    return (await this.all(sql, params))[0];
  }
  async run(sql: string, params: unknown[] = []) {
    await this.ready;
    const r = await this.pool.query(toPgPlaceholders(sql), params);
    return r.rowCount ?? 0;
  }
  async close() {
    await this.pool.end();
  }
}
