// 元库后端与 DDL —— 共享库 + workspace_id（B 方案）。后端可换：
//   离线开发：单文件 SQLite（ONTOS_META_DSN 不设，即开即用；隔离在列上不在文件上）
//   生产：ONTOS_META_DSN=mysql://user:pass@host:port/db（DDL 即设计文档 MySQL 8 方言）
// workspace_id 的过滤纪律收在各关切 store：方法第一个参数就是空间名，调用方不碰 SQL。

import { DatabaseSync } from "node:sqlite";
import mysql from "mysql2/promise";


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
    for (const m of MIGRATIONS) {
      try {
        this.db.exec(m);
      } catch {
        /* 列已存在 */
      }
    }
    this.migrateWorkingRow();
  }

  /* 一次性迁移（幂等）：旧双列（layout/draft_json）拼工作行；版本表重建出可空 version（SQLite 改不了列约束，只能建新表搬家，顺带丢 revert_of）；删老列。 */
  private migrateWorkingRow(): void {
    const vCols = this.db.prepare(`PRAGMA table_info(onto_version)`).all() as { name: string; notnull: number }[];
    if (vCols.find((c) => c.name === "version")?.notnull === 1) {
      const hasCanvas = vCols.some((c) => c.name === "canvas_json");
      this.db.exec(`DROP TABLE IF EXISTS onto_version_new`);
      this.db.exec(`CREATE TABLE onto_version_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL,
        version INTEGER,
        yaml TEXT NOT NULL DEFAULT '',
        canvas_json TEXT,
        origin TEXT NOT NULL DEFAULT 'publish',
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (workspace_id, version)
      )`);
      this.db
        .prepare(
          `INSERT INTO onto_version_new (workspace_id, version, yaml, ${hasCanvas ? "canvas_json," : ""} origin, note, created_at)
           SELECT workspace_id, version, yaml, ${hasCanvas ? "canvas_json," : ""} origin, note, created_at FROM onto_version`
        )
        .run();
      this.db.exec(`DROP TABLE onto_version`);
      this.db.exec(`ALTER TABLE onto_version_new RENAME TO onto_version`);
    }
    const wCols = (this.db.prepare(`PRAGMA table_info(onto_workspace)`).all() as { name: string }[]).map((c) => c.name);
    const hasDraft = wCols.includes("draft_json");
    const hasLayout = wCols.includes("layout");
    if (!hasDraft && !hasLayout) return;
    const rows = this.db
      .prepare(`SELECT id${hasDraft ? ", draft_json" : ""}${hasLayout ? ", layout" : ""} FROM onto_workspace`)
      .all() as Record<string, unknown>[];
    for (const row of rows) {
      const pack = stitchWorkingPack(row.draft_json, row.layout);
      if (pack === undefined) continue;
      const wsid = row.id as number;
      const existing = this.db.prepare(`SELECT id FROM onto_version WHERE workspace_id = ? AND version IS NULL`).get(wsid);
      if (existing) continue;
      this.db.prepare(`INSERT INTO onto_version (workspace_id, version, yaml, canvas_json, origin) VALUES (?, NULL, '', ?, 'publish')`).run(wsid, JSON.stringify(pack));
    }
    if (hasLayout) this.db.exec(`ALTER TABLE onto_workspace DROP COLUMN layout`);
    if (hasDraft) this.db.exec(`ALTER TABLE onto_workspace DROP COLUMN draft_json`);
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
    this.ready = this.pool
      .query(MYSQL_DDL)
      .then(async () => {
        for (const m of MIGRATIONS) {
          try {
            await this.pool.query(m);
          } catch {
            /* 列已存在 */
          }
        }
      })
      .then(() => this.migrateWorkingRow());
  }
  private ready: Promise<void>;

  /* 一次性迁移（幂等），与 SQLite 版同编排；MySQL 可以直接 MODIFY/带判断地 DROP，不用重建表。 */
  private async migrateWorkingRow(): Promise<void> {
    const vCols = await this.pool.query(
      `SELECT COLUMN_NAME AS name, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'onto_version'`
    ).then(([rows]) => rows as { name: string; nullable: string }[]);
    const versionCol = vCols.find((c) => c.name === "version");
    if (versionCol?.nullable === "NO") await this.pool.query(`ALTER TABLE onto_version MODIFY COLUMN version INT NULL`);
    if (vCols.some((c) => c.name === "revert_of")) await this.pool.query(`ALTER TABLE onto_version DROP COLUMN revert_of`);
    const wCols = await this.pool.query(
      `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'onto_workspace'`
    ).then(([rows]) => (rows as { name: string }[]).map((c) => c.name));
    const hasDraft = wCols.includes("draft_json");
    const hasLayout = wCols.includes("layout");
    if (!hasDraft && !hasLayout) return;
    const [rows] = await this.pool.query(`SELECT id${hasDraft ? ", draft_json" : ""}${hasLayout ? ", layout" : ""} FROM onto_workspace`);
    for (const row of rows as Record<string, unknown>[]) {
      const pack = stitchWorkingPack(row.draft_json, row.layout);
      if (pack === undefined) continue;
      const [existing] = await this.pool.query(`SELECT id FROM onto_version WHERE workspace_id = ? AND version IS NULL`, [row.id]);
      if ((existing as unknown[]).length) continue;
      await this.pool.query(`INSERT INTO onto_version (workspace_id, version, yaml, canvas_json, origin) VALUES (?, NULL, '', ?, 'publish')`, [row.id, JSON.stringify(pack)]);
    }
    if (hasLayout) await this.pool.query(`ALTER TABLE onto_workspace DROP COLUMN layout`);
    if (hasDraft) await this.pool.query(`ALTER TABLE onto_workspace DROP COLUMN draft_json`);
  }
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

/* ---------- DDL（两个方言，同一张结构） ---------- */

const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS onto_workspace (   -- 工作空间注册表：一个空间一行，只登记身份（画布内容全在 onto_version 的工作行）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,                  -- 空间名（小写字母/数字/中划线/下划线）
  seed_from TEXT,                             -- 起步来源：template=演示模板；lazy=被元数据写抢注
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS onto_version (     -- 版本链 + 工作行：编号行是不可变历史；version IS NULL 的是工作行（每空间恰一行的可变头）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  version INTEGER,                            -- 已发布编号（首版为 1）；NULL = 工作行
  yaml TEXT NOT NULL DEFAULT '',              -- 本体 YAML 全量快照（不存增量 diff）；工作行恒空串（内容在 canvas_json）
  canvas_json TEXT,                           -- 画布包 JSON：{ config, layout, edgeBends, edgePins }；老编号行可能没有
  origin TEXT NOT NULL DEFAULT 'publish',     -- 恒 publish（工作行带默认值，不读它）；rollback 行只见于历史库
  note TEXT,                                  -- 发布说明
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, version)
);
CREATE TABLE IF NOT EXISTS conn_source (      -- 数据源连接：本体按 name 引用
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,                         -- 连接名
  type TEXT NOT NULL,                         -- mysql | pg | sqlite
  host TEXT,
  port INTEGER,
  db_name TEXT,
  ro_user TEXT,                               -- 只读账号：读表结构与问数用
  ro_pass TEXT,                               -- 密码加密存
  rw_user TEXT,                               -- 可写账号：动作写回用，可空
  rw_pass TEXT,                               -- 密码加密存
  options TEXT,                               -- 方言项 JSON：ssl、超时等
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, name)
);
CREATE TABLE IF NOT EXISTS adj_decision (     -- 裁决留痕：人定的，不可重算
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  version INTEGER,                            -- 结论生效的已发布版本，发布时回填
  class_a TEXT NOT NULL,                      -- 被裁决的两个类
  class_b TEXT NOT NULL,
  source_a TEXT NOT NULL,                     -- 两个类各自来自的连接
  source_b TEXT NOT NULL,
  llm_advice TEXT,                            -- 模型建议与依据
  rate REAL,                                  -- 裁决时看到的交集率
  evidence TEXT,                              -- 证据快照 JSON：归一化规则、样本量、交集数；交集可重算，快照留裁决时点
  verdict TEXT NOT NULL,                      -- same | overlap | stage | name_similar | skip（同一 | 部分重叠 | 阶段 | 仅名称相似 | 跳过）
  decided_by TEXT NOT NULL,                   -- 裁决人
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS adj_overlap (      -- 交集计算记录：机器算的，可重算；只落计数，标识值集合不落盘
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  class_a TEXT NOT NULL,                      -- 被比对的两个类
  class_b TEXT NOT NULL,
  norm_rule TEXT,                             -- 归一化规则
  count_a INTEGER NOT NULL,                   -- 两类的标识数
  count_b INTEGER NOT NULL,
  count_hit INTEGER NOT NULL,                 -- 交集数
  rate REAL NOT NULL,                         -- 交集率 = |交集| / max(|A|, |B|)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ont_question (     -- 验收问题集
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  version INTEGER,                            -- 最后一次跑批时的本体版本
  question TEXT NOT NULL,                     -- 自然语言问题
  expected TEXT,                              -- 纯数字=比对行数；字段=值=至少一行对上；留空=能查出就算过
  status TEXT NOT NULL DEFAULT '未跑',        -- 未跑 / 通过 / 编译失败 / 执行出错 / 答案不符
  detail TEXT                                 -- 失败原因（白话），通过时清空
);
CREATE TABLE IF NOT EXISTS log_query (        -- 问数留痕：存请求与成败，不存结果集
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  version INTEGER,                            -- 查询依据的本体版本
  session_id TEXT,                            -- 关联的会话
  model TEXT,                                 -- 编查询用的模型（离线回退也记）
  question TEXT,                              -- 自然语言问题
  query_json TEXT,                            -- 编出的结构化查询
  row_count INTEGER,                          -- 当时返回的行数；不是结果集
  error TEXT,                                 -- 失败原因摘要
  duration_ms INTEGER,                        -- 耗时（毫秒）
  ok INTEGER NOT NULL,                        -- 1 成 0 败
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS log_action (       -- 动作留痕
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  version INTEGER,                            -- 动作依据的本体版本
  action TEXT NOT NULL,                       -- 动作名
  object_type TEXT NOT NULL,                  -- 类名
  subject TEXT NOT NULL,                      -- 请求点名的个体识别值
  request_json TEXT,                          -- 请求参数
  projections TEXT,                           -- 各条写回的成败 JSON；演示期不拆子表
  error TEXT,                                 -- 前置/公理拒绝的原因；拒绝发生在写回之前
  duration_ms INTEGER,                        -- 耗时（毫秒）
  ok INTEGER NOT NULL,                        -- 1 成 0 败
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS meta_seq (         -- 发号器：generate 的 sequence 片段按名取号
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,                         -- 序列名（如 appt_no）；按空间分开，各自起号
  value INTEGER NOT NULL,                     -- 当前已发到几号
  PRIMARY KEY (workspace_id, name)
);
`;

const MYSQL_DDL = SQLITE_DDL.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, "BIGINT PRIMARY KEY AUTO_INCREMENT")
  .replace(/PRIMARY KEY \(workspace_id, name\)/g, "PRIMARY KEY (workspace_id, name)")
  .replace(/datetime\('now'\)/g, "CURRENT_TIMESTAMP")
  .replace(/REAL/g, "DOUBLE") + ";";

/* 旧库补列：CREATE TABLE IF NOT EXISTS 不会给已存在的表加列，逐条试加，报「列已存在」就跳过。 */
const MIGRATIONS = [
  `ALTER TABLE ont_question ADD COLUMN detail TEXT`,
  `ALTER TABLE onto_version ADD COLUMN canvas_json TEXT`, // 预 WIP 老库补上，工作行迁移的 INSERT SELECT 要它
];

/** 老双列拼工作行画布包（纯函数，两个方言的迁移共用）：draft_json 优先，界面状态缺键回退 layout 列。
 *  只存过摆位（无草稿）的空间也造工作行——pack 不带 config 键，本体由 getDraft 用已发布补上（首次写入即补全）。 */
function stitchWorkingPack(draftRaw: unknown, layoutRaw: unknown): unknown | undefined {
  const parse = (v: unknown): unknown => {
    if (typeof v !== "string" || !v.length) return undefined;
    try {
      return JSON.parse(v);
    } catch {
      return undefined;
    }
  };
  const l = parse(layoutRaw);
  const lo = l && typeof l === "object" ? (l as Record<string, unknown>) : {};
  const nodes = "nodes" in lo ? lo.nodes : l; // layout 列旧格式是平铺的节点摆位（没有 nodes 键）
  const draft = parse(draftRaw);
  if (draft === undefined) {
    if (nodes === undefined && lo.edges === undefined && lo.pins === undefined) return undefined; // 全空，不造
    return { layout: nodes ?? {}, edgeBends: lo.edges ?? {}, edgePins: lo.pins ?? {} };
  }
  const d = draft && typeof draft === "object" ? (draft as Record<string, unknown>) : {};
  return {
    config: "config" in d ? d.config : draft, // 旧格式顶上就是 object_types
    layout: d.layout ?? nodes ?? {},
    edgeBends: d.edgeBends ?? lo.edges ?? {},
    edgePins: d.edgePins ?? lo.pins ?? {},
  };
}

