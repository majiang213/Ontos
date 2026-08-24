// MySQL / PG 源驱动 —— M1 连接器。连接池惰性建立（首次查询才拨号）；
// 问数走只读账号，动作走可写账号。内省走 information_schema；采样 3 行且敏感列脱敏。
// 两个实现曾是逐方法同构的孪生类：真实差异只有四点（池构造/查询协议/受影响行数/内省 SQL 与参数），
// 收成一个 PoolDriver + 两条方言配置——加第三种 SQL 源从「抄一个类」变成「写一条配置」。

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

/** 查询治理：单条 SQL 的库内超时（毫秒）。演示与活体共用一道闸（mysql 按查询给、pg 建池给，归一到 runQuery/makePool 各管）。 */
const QUERY_TIMEOUT_MS = 10_000;

/** 方言差异的全部四点：池构造 / 查询协议（含超时与受影响行数）/ 内省 SQL / 内省参数与默认端口。 */
interface PoolDialectCfg<P> {
  dialect: "mysql" | "pg";
  defaultPort: number;
  introspectSql: string;
  introspectArg: (cfg: SqlConnectionCfg) => string;
  makePool: (o: { host?: string; port: number; database?: string; user?: string; password?: string }) => P;
  runQuery: (pool: P, sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[]; affected: number }>;
}

/** 池驱动统一实现：惰性双键池（ro/rw）、select/insert/update/delete/sample/introspect 的共用骨架。 */
class PoolDriver<P extends { end(): Promise<void> }> implements SourceDriver {
  readonly dialect: "mysql" | "pg";
  private pools = new Map<string, P>();

  constructor(
    private cfg: SqlConnectionCfg,
    private d: PoolDialectCfg<P>
  ) {
    this.dialect = d.dialect;
  }

  private pool(writable: boolean): P {
    const key = writable ? "rw" : "ro";
    let p = this.pools.get(key);
    if (!p) {
      p = this.d.makePool({
        host: this.cfg.host,
        port: this.cfg.port ?? this.d.defaultPort,
        database: this.cfg.db_name,
        user: writable ? (this.cfg.rw_user ?? this.cfg.ro_user) : this.cfg.ro_user,
        password: writable ? (this.cfg.rw_pass ?? this.cfg.ro_pass) : this.cfg.ro_pass,
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
    return (await this.d.runQuery(this.pool(false), sql, params)).rows;
  }

  async insert(connection: string, table: string, row: Record<string, unknown>) {
    const { sql, params } = buildInsert(this.dialect, table, row);
    await this.d.runQuery(this.pool(true), sql, params);
  }

  async update(connection: string, table: string, set: Record<string, unknown>, conditions: Condition[]) {
    const { sql, params } = buildStatement(this.dialect, "update", table, { set, conditions });
    return (await this.d.runQuery(this.pool(true), sql, params)).affected;
  }

  async delete(connection: string, table: string, conditions: Condition[]) {
    const { sql, params } = buildStatement(this.dialect, "delete", table, { conditions });
    return (await this.d.runQuery(this.pool(true), sql, params)).affected;
  }

  async introspect(): Promise<TableInfo[]> {
    const { rows } = await this.d.runQuery(this.pool(false), this.d.introspectSql, [this.d.introspectArg(this.cfg)]);
    return groupColumns(rows);
  }

  async sample(connection: string, table: string, limit = 3) {
    const { sql, params } = buildSelect(table, [], [], this.dialect, limit);
    const { rows } = await this.d.runQuery(this.pool(false), sql, params);
    return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, maskValue(k, v)])));
  }
}

const MYSQL_CFG: PoolDialectCfg<mysql.Pool> = {
  dialect: "mysql",
  defaultPort: 3306,
  introspectSql: INTROSPECT_MYSQL,
  introspectArg: (cfg) => cfg.db_name ?? "",
  makePool: (o) =>
    mysql.createPool({
      ...o,
      connectionLimit: 4,
      dateStrings: true, // DATE/DATETIME 按字符串回来（引擎的日期契约是 ISO 串/Unix 秒），不要 JS Date
    }),
  runQuery: async (pool, sql, params) => {
    // 查询选项形态：库内超时按条给（DML 曾不带超时，归一后同闸）
    const [res] = await pool.query({ sql, timeout: QUERY_TIMEOUT_MS }, params);
    return { rows: res as Record<string, unknown>[], affected: (res as mysql.ResultSetHeader).affectedRows ?? 0 };
  },
};

const PG_CFG: PoolDialectCfg<pg.Pool> = {
  dialect: "pg",
  defaultPort: 5432,
  introspectSql: INTROSPECT_PG,
  introspectArg: () => "public",
  makePool: (o) => {
    const p = new pg.Pool({ ...o, max: 4, statement_timeout: QUERY_TIMEOUT_MS }); // 库内超时建池给，慢查询由库掐断
    p.on("error", () => {}); // 空闲连接掉线不炸进程（pg 官方要求）
    return p;
  },
  runQuery: async (pool, sql, params) => {
    const res = await pool.query(sql, params);
    return { rows: res.rows as Record<string, unknown>[], affected: res.rowCount ?? 0 };
  },
};

export function makeSqlDriver(rec: { type: string } & SqlConnectionCfg): SourceDriver {
  return rec.type === "pg" ? new PoolDriver(rec, PG_CFG) : new PoolDriver(rec, MYSQL_CFG);
}
