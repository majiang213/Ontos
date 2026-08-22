// MySQL / PG 源驱动 —— M1 连接器。连接池惰性建立（首次查询才拨号）；
// 问数走只读账号，动作走可写账号。内省走 information_schema；采样 3 行且敏感列脱敏。

import mysql from "mysql2/promise";
import pg from "pg";
import { buildInsert, buildSelect, buildStatement, maskValue, type Condition, type SourceDriver, type TableInfo } from "./driver";

export interface SqlConnectionCfg {
  host?: string;
  port?: number;
  db_name?: string;
  ro_user?: string;
  ro_pass?: string;
  rw_user?: string;
  rw_pass?: string;
}

// SQL 构造的唯一出处是 driver.ts（buildSelect/buildStatement/buildInsert，内部渲染占位符）。

// PG 的日期列按串返回，别给 JS Date（引擎的值契约是 ISO 串/Unix 秒）：
// DATE(1082)/TIMESTAMP(1114) 原样（resolveLiteral 按 UTC 补 Z）；TIMESTAMPTZ(1184) 带时区偏移，转 ISO。
pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(1114, (v: string) => v);
pg.types.setTypeParser(1184, (v: string) => {
  // pg 给 "2026-08-18 10:00:00.123456+00"：补 T、裁微秒、时区偏移补齐分钟，再转 ISO
  const norm = v.replace(" ", "T").replace(/\.\d+(?=[+-])/, "").replace(/([+-]\d{2})$/, "$1:00");
  const ms = Date.parse(norm);
  return Number.isNaN(ms) ? v : new Date(ms).toISOString();
});

const INTROSPECT_MYSQL = `SELECT TABLE_NAME AS name, COLUMN_NAME AS \`column\`, COLUMN_TYPE AS type, COLUMN_KEY AS keyflag, COLUMN_COMMENT AS comment
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`;
const INTROSPECT_PG = `SELECT c.table_name AS name, c.column_name AS column, c.data_type AS type,
    CASE WHEN kcu.column_name IS NULL THEN '' ELSE 'PRI' END AS keyflag,
    pg_catalog.col_description((quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass::oid, c.ordinal_position) AS comment
  FROM information_schema.columns c
  LEFT JOIN information_schema.table_constraints tc ON tc.table_name = c.table_name AND tc.table_schema = c.table_schema AND tc.constraint_type = 'PRIMARY KEY'
  LEFT JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema AND kcu.table_name = c.table_name AND kcu.column_name = c.column_name
  WHERE c.table_schema = $1 ORDER BY c.table_name, c.ordinal_position`;

function groupColumns(rows: Record<string, unknown>[]): TableInfo[] {
  const map = new Map<string, TableInfo>();
  for (const r of rows) {
    const name = String(r.name);
    const t = map.get(name) ?? { name, columns: [] };
    t.columns.push({ name: String(r.column), type: String(r.type), pk: r.keyflag === "PRI", ...(r.comment ? { comment: String(r.comment) } : {}) });
    map.set(name, t);
  }
  return [...map.values()];
}

/** 查询治理：单条 SQL 的库内超时（毫秒）。演示与活体共用一道闸。 */
const QUERY_TIMEOUT_MS = 10_000;

export class MysqlDriver implements SourceDriver {
  readonly dialect = "mysql" as const;
  private pools = new Map<string, mysql.Pool>();

  constructor(private cfg: SqlConnectionCfg) {}

  private pool(writable: boolean): mysql.Pool {
    const key = writable ? "rw" : "ro";
    let p = this.pools.get(key);
    if (!p) {
      p = mysql.createPool({
        host: this.cfg.host,
        port: this.cfg.port ?? 3306,
        database: this.cfg.db_name,
        user: writable ? (this.cfg.rw_user ?? this.cfg.ro_user) : this.cfg.ro_user,
        password: writable ? (this.cfg.rw_pass ?? this.cfg.ro_pass) : this.cfg.ro_pass,
        connectionLimit: 4,
        dateStrings: true, // DATE/DATETIME 按字符串回来（引擎的日期契约是 ISO 串/Unix 秒），不要 JS Date
      });
      this.pools.set(key, p);
    }
    return p;
  }

  async close(): Promise<void> {
    for (const p of this.pools.values()) await p.end();
    this.pools.clear();
  }

  async select(connection: string, table: string, columns: string[], conditions: Condition[], limit?: number) {
    const { sql, params } = buildSelect(table, columns, conditions, this.dialect, limit);
    const [rows] = await this.pool(false).query({ sql, timeout: QUERY_TIMEOUT_MS }, params);
    return rows as Record<string, unknown>[];
  }

  async insert(connection: string, table: string, row: Record<string, unknown>) {
    const { sql, params } = buildInsert(this.dialect, table, row);
    await this.pool(true).query(sql, params);
  }

  async update(connection: string, table: string, set: Record<string, unknown>, conditions: Condition[]) {
    const { sql, params } = buildStatement(this.dialect, "update", table, { set, conditions });
    const [res] = await this.pool(true).query(sql, params);
    return (res as mysql.ResultSetHeader).affectedRows ?? 0;
  }

  async delete(connection: string, table: string, conditions: Condition[]) {
    const { sql, params } = buildStatement(this.dialect, "delete", table, { conditions });
    const [res] = await this.pool(true).query(sql, params);
    return (res as mysql.ResultSetHeader).affectedRows ?? 0;
  }

  async introspect(): Promise<TableInfo[]> {
    const [rows] = await this.pool(false).query(INTROSPECT_MYSQL, [this.cfg.db_name]);
    return groupColumns(rows as Record<string, unknown>[]);
  }

  async sample(connection: string, table: string, limit = 3) {
    const { sql, params } = buildSelect(table, [], [], this.dialect, limit);
    const [rows] = await this.pool(false).query({ sql, timeout: QUERY_TIMEOUT_MS }, params);
    return (rows as Record<string, unknown>[]).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, maskValue(k, v)])));
  }
}

export class PgDriver implements SourceDriver {
  readonly dialect = "pg" as const;
  private pools = new Map<string, pg.Pool>();

  constructor(private cfg: SqlConnectionCfg) {}

  private pool(writable: boolean): pg.Pool {
    const key = writable ? "rw" : "ro";
    let p = this.pools.get(key);
    if (!p) {
      p = new pg.Pool({
        host: this.cfg.host,
        port: this.cfg.port ?? 5432,
        database: this.cfg.db_name,
        user: writable ? (this.cfg.rw_user ?? this.cfg.ro_user) : this.cfg.ro_user,
        password: writable ? (this.cfg.rw_pass ?? this.cfg.ro_pass) : this.cfg.ro_pass,
        max: 4,
        statement_timeout: QUERY_TIMEOUT_MS, // 库内超时，慢查询由库掐断
      });
      p.on("error", () => {}); // 空闲连接掉线不炸进程（pg 官方要求）
      this.pools.set(key, p);
    }
    return p;
  }

  async close(): Promise<void> {
    for (const p of this.pools.values()) await p.end();
    this.pools.clear();
  }

  async select(connection: string, table: string, columns: string[], conditions: Condition[], limit?: number) {
    const { sql, params } = buildSelect(table, columns, conditions, this.dialect, limit); // 占位符已内部渲染
    const res = await this.pool(false).query(sql, params);
    return res.rows as Record<string, unknown>[];
  }

  async insert(connection: string, table: string, row: Record<string, unknown>) {
    const { sql, params } = buildInsert(this.dialect, table, row);
    await this.pool(true).query(sql, params);
  }

  async update(connection: string, table: string, set: Record<string, unknown>, conditions: Condition[]) {
    const { sql, params } = buildStatement(this.dialect, "update", table, { set, conditions });
    const res = await this.pool(true).query(sql, params);
    return res.rowCount ?? 0;
  }

  async delete(connection: string, table: string, conditions: Condition[]) {
    const { sql, params } = buildStatement(this.dialect, "delete", table, { conditions });
    const res = await this.pool(true).query(sql, params);
    return res.rowCount ?? 0;
  }

  async introspect(): Promise<TableInfo[]> {
    const res = await this.pool(false).query(INTROSPECT_PG, ["public"]);
    return groupColumns(res.rows as Record<string, unknown>[]);
  }

  async sample(connection: string, table: string, limit = 3) {
    const { sql, params } = buildSelect(table, [], [], this.dialect, limit); // 与 mysql 同款：buildSelect + LIMIT
    const res = await this.pool(false).query(sql, params);
    return (res.rows as Record<string, unknown>[]).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, maskValue(k, v)])));
  }
}

export function makeSqlDriver(rec: { type: string } & SqlConnectionCfg): SourceDriver {
  return rec.type === "pg" ? new PgDriver(rec) : new MysqlDriver(rec);
}
