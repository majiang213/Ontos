// 元库后端 —— 共享库 + workspace_id（B 方案）。后端可换：
//   离线开发：单文件 SQLite（ONTOS_META_DSN 不设，即开即用；隔离在列上不在文件上）
//   生产：ONTOS_META_DSN=mysql://user:pass@host:port/db
// DDL 一种数据库一个文件（./ddl/sqlite.ts、./ddl/mysql.ts 同构手写）；老库不重建，打开时按列存在性跑幂等 ALTER 迁移
// （无状态化加的 rev / draft_key 与工作行唯一索引，见 ddl 两方言末尾的迁移常量；meta_seq 老表随迁移丢弃）。
// workspace_id 的过滤纪律收在各关切 store：方法第一个参数就是空间名，调用方不碰 SQL。

import { DatabaseSync } from "node:sqlite";
import mysql from "mysql2/promise";
import { SQLITE_DDL, SQLITE_ALTER_REV, SQLITE_ALTER_DRAFT_KEY, SQLITE_INDEX_DRAFT_KEY, SQLITE_DROP_SEQ } from "./ddl/sqlite";
import { MYSQL_DDL, MYSQL_ALTER_REV, MYSQL_ALTER_DRAFT_KEY, MYSQL_INDEX_DRAFT_KEY, MYSQL_DROP_SEQ } from "./ddl/mysql";


/* ---------- 后端 ---------- */

export interface MetaBackend {
  readonly dialect: "sqlite" | "mysql";
  all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  get(sql: string, params?: unknown[]): Promise<Record<string, unknown> | undefined>;
  /** 执行写语句，返回受影响行数（CAS 依赖：0 行 = 条件不命中 = 冲突）。
   *  方言计数口径不同：SQLite 的 changes 计「命中的行」（值相同也计），MySQL 的 affectedRows 计「值真变的行」。
   *  契约靠调用方的不变量对齐：所有 CAS 写都 bump rev（rev = rev + 1），值必变，两方言都返回 1。 */
  run(sql: string, params?: unknown[]): Promise<number>;
  close(): Promise<void>;
}

export class SqliteBackend implements MetaBackend {
  readonly dialect = "sqlite" as const;
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA foreign_keys = ON"); // DDL 声明的 FK 靠这句生效（SQLite 默认不查）；父行先插由 wsId 兜，开启安全
    this.db.exec(SQLITE_DDL);
    migrateSqlite(this.db); // 老库补 rev / draft_key 列 + 工作行唯一索引；新库两列已在 DDL 里，判列后直接跳过
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

export class MysqlBackend implements MetaBackend {
  readonly dialect = "mysql" as const;
  private pool: mysql.Pool;
  constructor(dsn: string) {
    // multipleStatements 必须开：MYSQL_DDL 九个 CREATE TABLE 一次下发（不开 mysql2 默认拒多语句，ready 永远 reject）
    this.pool = mysql.createPool({ uri: dsn, connectionLimit: 4, namedPlaceholders: false, multipleStatements: true });
    this.ready = this.pool.query(MYSQL_DDL).then(() => migrateMysql(this.pool)); // 老库补列 + 工作行唯一索引（判列后跳过新库）
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

/* ---------- 旧库迁移（幂等） ---------- */

function migrateSqlite(db: DatabaseSync): void {
  // table_xinfo 才报生成列（table_info 对 VIRTUAL 生成列隐身，会误判新库缺列而重复 ALTER）
  const cols = new Set((db.prepare(`PRAGMA table_xinfo(onto_version)`).all() as { name: string }[]).map((c) => c.name));
  if (cols.has("rev") && cols.has("draft_key")) return; // 新库或已迁移：列都在，什么都不做
  if (!cols.has("rev")) db.exec(SQLITE_ALTER_REV);
  if (!cols.has("draft_key")) db.exec(SQLITE_ALTER_DRAFT_KEY);
  db.exec(SQLITE_INDEX_DRAFT_KEY); // 老库从来没有 draft_key，索引只会在迁移路径上建，不与 DDL 里的 UNIQUE 重复
  db.exec(SQLITE_DROP_SEQ); // 发号器已改雪花：老库的计数器表随迁移丢弃
}

async function migrateMysql(pool: mysql.Pool): Promise<void> {
  const cols = await mysqlVersionColumns(pool);
  if (!(cols.has("rev") && cols.has("draft_key"))) {
    try {
      if (!cols.has("rev")) await pool.query(MYSQL_ALTER_REV);
      if (!cols.has("draft_key")) await pool.query(MYSQL_ALTER_DRAFT_KEY);
    } catch (e) {
      // 多实例同时对老库启动：后到的 ALTER 撞「列已存在」。重查列，已齐则视为对方迁移完成；否则原样上抛
      const now = await mysqlVersionColumns(pool);
      if (!(now.has("rev") && now.has("draft_key"))) throw e;
    }
  }
  // 唯一索引独立于列迁移：对方可能加完列后死在建索引前——只查列会静默放过缺失的「每空间恰一行」保证
  if (!(await mysqlHasDraftKeyIndex(pool))) {
    try {
      await pool.query(MYSQL_INDEX_DRAFT_KEY);
    } catch (e) {
      if (!(await mysqlHasDraftKeyIndex(pool))) throw e; // 对方恰在此刻建好：重查后放行
    }
  }
  await pool.query(MYSQL_DROP_SEQ); // DROP TABLE IF EXISTS 幂等，新库老库都跑
}

async function mysqlVersionColumns(pool: mysql.Pool): Promise<Set<string>> {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'onto_version'`
  );
  return new Set((rows as { name: string }[]).map((c) => c.name));
}

async function mysqlHasDraftKeyIndex(pool: mysql.Pool): Promise<boolean> {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'onto_version' AND INDEX_NAME = 'uq_draft_key'`
  );
  return (rows as unknown[]).length > 0;
}
