// MySQL / PG 源驱动 —— M1 连接器。连接池惰性建立（首次查询才拨号）；
// 问数走只读账号，动作走可写账号。内省走 information_schema；采样 3 行且敏感列脱敏。

import mysql from "mysql2/promise";
import pg from "pg";
import { buildSelect, conditionSql, maskValue, quoteFor, renderPlaceholders, type Condition, type SourceDriver, type TableInfo } from "./driver";

export interface SqlConnectionCfg {
  host?: string;
  port?: number;
  db_name?: string;
  ro_user?: string;
  ro_pass?: string;
  rw_user?: string;
  rw_pass?: string;
}

/** 统一 SQL 构造：占位符先写 ?，pg 渲染成 $1..$n。 */
export function buildStatement(
  dialect: "mysql" | "pg",
  kind: "select" | "update" | "delete",
  table: string,
  opts: { columns?: string[]; set?: Record<string, unknown>; conditions?: Condition[] }
): { sql: string; params: unknown[] } {
  const quote = quoteFor(dialect);
  const conds = (opts.conditions ?? []).map((c) => conditionSql(c, quote));
  const where = conds.length ? ` WHERE ${conds.map((p) => p.sql).join(" AND ")}` : "";
  let sql: string;
  let params: unknown[];
  if (kind === "select") {
    const cols = opts.columns?.length ? opts.columns.map(quote).join(", ") : "*";
    sql = `SELECT ${cols} FROM ${quote(table)}${where}`;
    params = conds.flatMap((p) => p.params);
  } else if (kind === "update") {
    const setCols = Object.keys(opts.set ?? {});
    sql = `UPDATE ${quote(table)} SET ${setCols.map((c) => `${quote(c)} = ?`).join(", ")}${where}`;
    params = [...setCols.map((c) => opts.set![c]), ...conds.flatMap((p) => p.params)];
  } else {
    sql = `DELETE FROM ${quote(table)}${where}`;
    params = conds.flatMap((p) => p.params);
  }
  return { sql: renderPlaceholders(sql, dialect), params };
}

export function buildInsert(dialect: "mysql" | "pg", table: string, row: Record<string, unknown>): { sql: string; params: unknown[] } {
  const quote = quoteFor(dialect);
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${quote(table)} (${cols.map(quote).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
  return { sql: renderPlaceholders(sql, dialect), params: cols.map((c) => row[c]) };
}

const INTROSPECT_MYSQL = `SELECT TABLE_NAME AS name, COLUMN_NAME AS \`column\`, COLUMN_TYPE AS type, COLUMN_KEY AS keyflag
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`;
const INTROSPECT_PG = `SELECT c.table_name AS name, c.column_name AS column, c.data_type AS type,
    CASE WHEN kcu.column_name IS NULL THEN '' ELSE 'PRI' END AS keyflag
  FROM information_schema.columns c
  LEFT JOIN information_schema.table_constraints tc ON tc.table_name = c.table_name AND tc.constraint_type = 'PRIMARY KEY'
  LEFT JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_name = c.table_name AND kcu.column_name = c.column_name
  WHERE c.table_schema = $1 ORDER BY c.table_name, c.ordinal_position`;

function groupColumns(rows: Record<string, unknown>[]): TableInfo[] {
  const map = new Map<string, TableInfo>();
  for (const r of rows) {
    const name = String(r.name);
    const t = map.get(name) ?? { name, columns: [] };
    t.columns.push({ name: String(r.column), type: String(r.type), pk: r.keyflag === "PRI" || r.keyflag === "MUL" || r.keyflag === "UNI" ? r.keyflag === "PRI" : r.keyflag === "PRI" });
    map.set(name, t);
  }
  return [...map.values()];
}

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
      });
      this.pools.set(key, p);
    }
    return p;
  }

  async select(connection: string, table: string, columns: string[], conditions: Condition[]) {
    const { sql, params } = buildSelect(table, columns, conditions, quoteFor(this.dialect));
    const [rows] = await this.pool(false).query(sql, params);
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
    const { sql, params } = buildSelect(table, [], [], quoteFor(this.dialect));
    const [rows] = await this.pool(false).query(`${sql} LIMIT ?`, [...params, limit]);
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
      });
      this.pools.set(key, p);
    }
    return p;
  }

  async select(connection: string, table: string, columns: string[], conditions: Condition[]) {
    const quote = quoteFor(this.dialect);
    const { sql, params } = buildSelect(table, columns, conditions, quote);
    const res = await this.pool(false).query(renderPlaceholders(sql, this.dialect), params);
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
    const quote = quoteFor(this.dialect);
    const res = await this.pool(false).query(`SELECT * FROM ${quote(table)} LIMIT $1`, [limit]);
    return (res.rows as Record<string, unknown>[]).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, maskValue(k, v)])));
  }
}

export function makeSqlDriver(rec: { type: string } & SqlConnectionCfg): SourceDriver {
  return rec.type === "pg" ? new PgDriver(rec) : new MysqlDriver(rec);
}
