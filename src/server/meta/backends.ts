// 元库后端 —— 共享库 + workspace_id（B 方案）。后端可换：
//   离线开发：单文件 SQLite（ONTOS_META_DSN 不设，即开即用；隔离在列上不在文件上）
//   生产：ONTOS_META_DSN=mysql://user:pass@host:port/db
// DDL 一种数据库一个文件（./ddl/sqlite.ts、./ddl/mysql.ts 同构手写）；不兼容旧库，老库直接删了重建。
// workspace_id 的过滤纪律收在各关切 store：方法第一个参数就是空间名，调用方不碰 SQL。

import { DatabaseSync } from "node:sqlite";
import mysql from "mysql2/promise";
import { SQLITE_DDL } from "./ddl/sqlite";
import { MYSQL_DDL } from "./ddl/mysql";


/* ---------- 后端 ---------- */

export interface MetaBackend {
  readonly dialect: "sqlite" | "mysql";
  all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  get(sql: string, params?: unknown[]): Promise<Record<string, unknown> | undefined>;
  run(sql: string, params?: unknown[]): Promise<void>;
  close(): Promise<void>;
}

export class SqliteBackend implements MetaBackend {
  readonly dialect = "sqlite" as const;
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(SQLITE_DDL);
  }

  async all(sql: string, params: unknown[] = []) {
    return this.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  }
  async get(sql: string, params: unknown[] = []) {
    return this.db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined;
  }
  async run(sql: string, params: unknown[] = []) {
    this.db.prepare(sql).run(...(params as never[]));
  }
  async close() {
    this.db.close();
  }
}

export class MysqlBackend implements MetaBackend {
  readonly dialect = "mysql" as const;
  private pool: mysql.Pool;
  constructor(dsn: string) {
    this.pool = mysql.createPool({ uri: dsn, connectionLimit: 4, namedPlaceholders: false });
    this.ready = this.pool.query(MYSQL_DDL).then(() => undefined);
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
    await this.pool.query(sql, params);
  }
  async close() {
    await this.pool.end();
  }
}
