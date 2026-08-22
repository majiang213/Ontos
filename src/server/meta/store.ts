// 平台元数据库 —— 共享库 + workspace_id（B 方案）。后端可换：
//   离线开发：单文件 SQLite（ONTOS_META_DSN 不设，即开即用；隔离在列上不在文件上）
//   生产：ONTOS_META_DSN=mysql://user:pass@host:port/db（DDL 即设计文档 MySQL 8 方言）
// workspace_id 的过滤纪律收在这一处：方法第一个参数就是空间名，调用方不碰 SQL。

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { runtime } from "../runtime";

/* ---------- 后端 ---------- */

interface MetaBackend {
  readonly dialect: "sqlite" | "mysql";
  all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  get(sql: string, params?: unknown[]): Promise<Record<string, unknown> | undefined>;
  run(sql: string, params?: unknown[]): Promise<void>;
  close(): Promise<void>;
}

class SqliteBackend implements MetaBackend {
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

class MysqlBackend implements MetaBackend {
  readonly dialect = "mysql" as const;
  private pool: mysql.Pool;
  constructor(dsn: string) {
    this.pool = mysql.createPool({ uri: dsn, connectionLimit: 4, namedPlaceholders: false });
    this.ready = this.pool.query(MYSQL_DDL).then(async () => {
      for (const m of MIGRATIONS) {
        try {
          await this.pool.query(m);
        } catch {
          /* 列已存在 */
        }
      }
    });
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

/* ---------- DDL（两个方言，同一张结构） ---------- */

const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS onto_workspace (   -- 工作空间注册表：一个空间一行
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,                  -- 空间名（小写字母/数字/中划线/下划线）
  seed_from TEXT,                             -- 起步来源：template=演示模板；lazy=被元数据写抢注
  layout TEXT,                                -- 画布界面状态 JSON：对象摆位 + 线的弯折点 + 端点钉点
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS onto_version (     -- 版本快照：发布/回滚各插一行，历史链不断
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  version INTEGER NOT NULL,                   -- 首版为 1；已发布版 = 该空间 MAX(version)
  yaml TEXT NOT NULL,                         -- 本体 YAML 全量快照（不存增量 diff）
  origin TEXT NOT NULL DEFAULT 'publish',     -- 恒 publish：回滚只覆盖工作副本、不插行；rollback 行只见于历史库
  revert_of INTEGER,                          -- 历史列：早期 revert 语义记的回滚来源，现行语义不写
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
const MIGRATIONS = [`ALTER TABLE ont_question ADD COLUMN detail TEXT`];

/* ---------- 记录类型 ---------- */

export interface ConnectionRec {
  name: string;
  type: "mysql" | "pg" | "sqlite";
  host?: string;
  port?: number;
  db_name?: string;
  ro_user?: string;
  ro_pass?: string;
  rw_user?: string;
  rw_pass?: string;
  options?: Record<string, unknown>;
}

export interface DecisionRec {
  version?: number;
  class_a: string;
  class_b: string;
  source_a: string;
  source_b: string;
  llm_advice?: string;
  rate?: number;
  evidence?: Record<string, unknown>;
  verdict: string;
  decided_by: string;
}

export interface OverlapRec {
  class_a: string;
  class_b: string;
  norm_rule?: string;
  count_a: number;
  count_b: number;
  count_hit: number;
  rate: number;
}

export interface QueryLogRec {
  version?: number;
  session_id?: string;
  model?: string;
  question?: string;
  query_json?: string;
  row_count?: number;
  error?: string;
  duration_ms?: number;
  ok: boolean;
}

/** 画布界面状态（onto_workspace.layout 的 JSON 形状）：对象摆位 + 线的弯折点。 */
export interface CanvasLayout {
  nodes: Record<string, { x: number; y: number }>;
  edges: Record<string, { dx: number; dy: number }>;
}

export interface ActionLogRec {
  version?: number;
  action: string;
  object_type: string;
  subject: string;
  request_json?: string;
  projections?: unknown;
  error?: string;
  duration_ms?: number;
  ok: boolean;
}

/* ---------- 存储 ---------- */

export class MetaStore {
  constructor(private backend: MetaBackend) {}

  async close() {
    await this.backend.close();
  }

  /* 工作空间（注册表） */

  async listWorkspaces(): Promise<string[]> {
    const rows = await this.backend.all(`SELECT name FROM onto_workspace ORDER BY name`);
    const names = rows.map((r) => r.name as string);
    return names.includes("default") ? names : ["default", ...names];
  }

  /** 注册（若不存在）并插入 v1 快照。返回该空间的 id。 */
  async ensureWorkspace(name: string, seedYaml: string, seedFrom = "template"): Promise<number> {
    const existing = await this.backend.get(`SELECT id FROM onto_workspace WHERE name = ?`, [name]);
    if (existing) return existing.id as number;
    await this.backend.run(`INSERT INTO onto_workspace (name, seed_from) VALUES (?, ?)`, [name, seedFrom]);
    const row = await this.backend.get(`SELECT id FROM onto_workspace WHERE name = ?`, [name]);
    const id = row!.id as number;
    await this.backend.run(`INSERT INTO onto_version (workspace_id, version, yaml, origin) VALUES (?, 1, ?, 'publish')`, [id, seedYaml]);
    return id;
  }

  /** 空间 id；未注册的先注册。版本行由 latestVersion 播种——元数据写（留痕/连接/问题集）可能先于配置访问碰到新空间。 */
  private async wsId(ws: string): Promise<number> {
    const row = await this.backend.get(`SELECT id FROM onto_workspace WHERE name = ?`, [ws]);
    if (row) return row.id as number;
    await this.backend.run(`INSERT INTO onto_workspace (name, seed_from) VALUES (?, ?)`, [ws, "lazy"]);
    return (await this.backend.get(`SELECT id FROM onto_workspace WHERE name = ?`, [ws]))!.id as number;
  }

  /* 版本链（YAML 全量快照入库） */

  async latestVersion(ws: string, seedYaml: string): Promise<{ version: number; yaml: string }> {
    const id = await this.wsId(ws);
    const row = await this.backend.get(`SELECT version, yaml FROM onto_version WHERE workspace_id = ? ORDER BY version DESC LIMIT 1`, [id]);
    if (row) return { version: row.version as number, yaml: row.yaml as string };
    await this.backend.run(`INSERT INTO onto_version (workspace_id, version, yaml, origin) VALUES (?, 1, ?, 'publish')`, [id, seedYaml]); // 被元数据写抢注的空间：种子补成 v1
    return { version: 1, yaml: seedYaml };
  }

  async insertVersion(ws: string, version: number, yaml: string, origin: "publish" | "rollback", revertOf?: number): Promise<void> {
    const id = await this.wsId(ws);
    await this.backend.run(`INSERT INTO onto_version (workspace_id, version, yaml, origin, revert_of) VALUES (?, ?, ?, ?, ?)`, [id, version, yaml, origin, revertOf ?? null]);
  }

  async listVersions(ws: string): Promise<{ version: number; createdAt: string; origin: string }[]> {
    const id = await this.wsId(ws);
    const rows = await this.backend.all(`SELECT version, origin, created_at FROM onto_version WHERE workspace_id = ? ORDER BY version`, [id]);
    return rows.map((r) => ({ version: r.version as number, origin: String(r.origin), createdAt: String(r.created_at) }));
  }

  async versionYaml(ws: string, version: number): Promise<string | undefined> {
    const id = await this.wsId(ws);
    const row = await this.backend.get(`SELECT yaml FROM onto_version WHERE workspace_id = ? AND version = ?`, [id, version]);
    return row?.yaml as string | undefined;
  }

  /* 摆位 */

  /** 画布界面状态：nodes = 对象摆位；edges = 线的弯折（相对两端节点中心连线中点的偏移，0/0 即直线）。 */
  async getLayout(ws: string): Promise<CanvasLayout> {
    const id = await this.wsId(ws);
    const row = await this.backend.get(`SELECT layout FROM onto_workspace WHERE id = ?`, [id]);
    if (!row?.layout) return { nodes: {}, edges: {} };
    try {
      const parsed = JSON.parse(String(row.layout));
      // 旧格式是平铺的节点摆位（没有 nodes 键），按 nodes 读、edges 置空
      if (parsed && typeof parsed === "object" && "nodes" in parsed) return { nodes: parsed.nodes ?? {}, edges: parsed.edges ?? {} };
      return { nodes: parsed ?? {}, edges: {} };
    } catch {
      return { nodes: {}, edges: {} };
    }
  }

  async setLayout(ws: string, layout: CanvasLayout): Promise<void> {
    const id = await this.wsId(ws);
    await this.backend.run(`UPDATE onto_workspace SET layout = ? WHERE id = ?`, [JSON.stringify(layout), id]);
  }

  /* 连接 */

  async saveConnection(ws: string, c: ConnectionRec): Promise<void> {
    const id = await this.wsId(ws);
    const cols = `(workspace_id, name, type, host, port, db_name, ro_user, ro_pass, rw_user, rw_pass, options)`;
    const vals = [id, c.name, c.type, c.host ?? null, c.port ?? null, c.db_name ?? null, c.ro_user ?? null, c.ro_pass ?? null, c.rw_user ?? null, c.rw_pass ?? null, c.options ? JSON.stringify(c.options) : null];
    const upsert =
      this.backend.dialect === "mysql"
        ? `ON DUPLICATE KEY UPDATE type=VALUES(type), host=VALUES(host), port=VALUES(port), db_name=VALUES(db_name), ro_user=VALUES(ro_user), ro_pass=VALUES(ro_pass), rw_user=VALUES(rw_user), rw_pass=VALUES(rw_pass), options=VALUES(options), updated_at=CURRENT_TIMESTAMP`
        : `ON CONFLICT(workspace_id, name) DO UPDATE SET type=excluded.type, host=excluded.host, port=excluded.port, db_name=excluded.db_name, ro_user=excluded.ro_user, ro_pass=excluded.ro_pass, rw_user=excluded.rw_user, rw_pass=excluded.rw_pass, options=excluded.options, updated_at=datetime('now')`;
    await this.backend.run(`INSERT INTO conn_source ${cols} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${upsert}`, vals);
  }

  async listConnections(ws: string): Promise<ConnectionRec[]> {
    const id = await this.wsId(ws);
    const rows = await this.backend.all(`SELECT * FROM conn_source WHERE workspace_id = ? ORDER BY name`, [id]);
    return rows.map((r) => ({
      name: r.name as string,
      type: r.type as ConnectionRec["type"],
      host: (r.host ?? undefined) as string | undefined,
      port: (r.port ?? undefined) as number | undefined,
      db_name: (r.db_name ?? undefined) as string | undefined,
      ro_user: (r.ro_user ?? undefined) as string | undefined,
      ro_pass: (r.ro_pass ?? undefined) as string | undefined,
      rw_user: (r.rw_user ?? undefined) as string | undefined,
      rw_pass: (r.rw_pass ?? undefined) as string | undefined,
      options: r.options ? JSON.parse(String(r.options)) : undefined,
    }));
  }

  async deleteConnection(ws: string, name: string): Promise<void> {
    const id = await this.wsId(ws);
    await this.backend.run(`DELETE FROM conn_source WHERE workspace_id = ? AND name = ?`, [id, name]);
  }

  /* 裁决与交集 */

  async recordDecision(ws: string, d: DecisionRec): Promise<void> {
    const id = await this.wsId(ws);
    await this.backend.run(
      `INSERT INTO adj_decision (workspace_id, version, class_a, class_b, source_a, source_b, llm_advice, rate, evidence, verdict, decided_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, d.version ?? null, d.class_a, d.class_b, d.source_a, d.source_b, d.llm_advice ?? null, d.rate ?? null, d.evidence ? JSON.stringify(d.evidence) : null, d.verdict, d.decided_by]
    );
  }

  async listDecisions(ws: string): Promise<(DecisionRec & { id: number; created_at: string })[]> {
    const id = await this.wsId(ws);
    const rows = await this.backend.all(`SELECT * FROM adj_decision WHERE workspace_id = ? ORDER BY id DESC`, [id]);
    return rows.map((r) => ({ ...r, evidence: r.evidence ? JSON.parse(String(r.evidence)) : undefined })) as never[];
  }

  /** 发布时回填：把还没绑版本的裁决挂上这个版本。 */
  async backfillDecisionVersions(ws: string, version: number): Promise<void> {
    const id = await this.wsId(ws);
    await this.backend.run(`UPDATE adj_decision SET version = ? WHERE workspace_id = ? AND version IS NULL`, [version, id]);
  }

  /** 放弃草稿时：未绑版本的裁决标成 -1（已放弃），不再随下一次发布回填。 */
  async abandonPendingDecisions(ws: string): Promise<void> {
    const id = await this.wsId(ws);
    await this.backend.run(`UPDATE adj_decision SET version = -1 WHERE workspace_id = ? AND version IS NULL`, [id]);
  }

  /** 交集按对更新（同一对重复计算只留最新计数）。 */
  async recordOverlap(ws: string, o: OverlapRec): Promise<void> {
    const id = await this.wsId(ws);
    await this.backend.run(`DELETE FROM adj_overlap WHERE workspace_id = ? AND class_a = ? AND class_b = ?`, [id, o.class_a, o.class_b]);
    await this.backend.run(
      `INSERT INTO adj_overlap (workspace_id, class_a, class_b, norm_rule, count_a, count_b, count_hit, rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, o.class_a, o.class_b, o.norm_rule ?? null, o.count_a, o.count_b, o.count_hit, o.rate]
    );
  }

  async listOverlaps(ws: string): Promise<(OverlapRec & { id: number; created_at: string })[]> {
    const id = await this.wsId(ws);
    return (await this.backend.all(`SELECT * FROM adj_overlap WHERE workspace_id = ? ORDER BY id DESC`, [id])) as never[];
  }

  /* 验收问题集 */

  async listQuestions(ws: string): Promise<{ id: number; question: string; expected?: string; status: string; detail?: string; version?: number }[]> {
    const id = await this.wsId(ws);
    return (await this.backend.all(`SELECT * FROM ont_question WHERE workspace_id = ? ORDER BY id`, [id])) as never[];
  }

  async addQuestion(ws: string, question: string, expected?: string): Promise<void> {
    const id = await this.wsId(ws);
    await this.backend.run(`INSERT INTO ont_question (workspace_id, question, expected) VALUES (?, ?, ?)`, [id, question, expected ?? null]);
  }

  async removeQuestion(ws: string, qid: number): Promise<void> {
    const id = await this.wsId(ws);
    await this.backend.run(`DELETE FROM ont_question WHERE workspace_id = ? AND id = ?`, [id, qid]);
  }

  async setQuestionStatus(ws: string, qid: number, status: string, version?: number, detail?: string): Promise<void> {
    const id = await this.wsId(ws);
    await this.backend.run(`UPDATE ont_question SET status = ?, detail = ?, version = COALESCE(?, version) WHERE workspace_id = ? AND id = ?`, [status, detail ?? null, version ?? null, id, qid]);
  }

  /* 日志（不存结果集） */

  async logQuery(ws: string, l: QueryLogRec): Promise<void> {
    const id = await this.wsId(ws);
    await this.backend.run(
      `INSERT INTO log_query (workspace_id, version, session_id, model, question, query_json, row_count, error, duration_ms, ok)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, l.version ?? null, l.session_id ?? null, l.model ?? null, l.question ?? null, l.query_json ?? null, l.row_count ?? null, l.error ?? null, l.duration_ms ?? null, l.ok ? 1 : 0]
    );
  }

  async logAction(ws: string, l: ActionLogRec): Promise<void> {
    const id = await this.wsId(ws);
    await this.backend.run(
      `INSERT INTO log_action (workspace_id, version, action, object_type, subject, request_json, projections, error, duration_ms, ok)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, l.version ?? null, l.action, l.object_type, l.subject, l.request_json ?? null, l.projections ? JSON.stringify(l.projections) : null, l.error ?? null, l.duration_ms ?? null, l.ok ? 1 : 0]
    );
  }

  async listQueryLogs(ws: string, limit = 50): Promise<Record<string, unknown>[]> {
    const id = await this.wsId(ws);
    return this.backend.all(`SELECT * FROM log_query WHERE workspace_id = ? ORDER BY id DESC LIMIT ?`, [id, limit]);
  }

  async listActionLogs(ws: string, limit = 50): Promise<Record<string, unknown>[]> {
    const id = await this.wsId(ws);
    return this.backend.all(`SELECT * FROM log_action WHERE workspace_id = ? ORDER BY id DESC LIMIT ?`, [id, limit]);
  }

  /** 发号器：进程重启不复位（动作 generate 的 sequence 走这里）。原子自增并返回新值。 */
  async nextSeq(ws: string, name: string, start = 1): Promise<number> {
    const id = await this.wsId(ws);
    const upsert =
      this.backend.dialect === "mysql"
        ? `ON DUPLICATE KEY UPDATE value = GREATEST(value + 1, VALUES(value))`
        : `ON CONFLICT(workspace_id, name) DO UPDATE SET value = MAX(value + 1, excluded.value)`;
    await this.backend.run(`INSERT INTO meta_seq (workspace_id, name, value) VALUES (?, ?, ?) ${upsert}`, [id, name, start]);
    const row = await this.backend.get(`SELECT value FROM meta_seq WHERE workspace_id = ? AND name = ?`, [id, name]);
    return row!.value as number;
  }
}

/* ---------- 单例（挂在 Runtime 上；一个共享后端，不按空间分实例） ---------- */

/** 共享元库入口。ONTOS_META_DSN=mysql://… 走 MySQL，否则离线单文件 SQLite（路径取运行态的 cwd）。 */
export function metaStore(): MetaStore {
  const rt = runtime();
  rt.meta ??= new MetaStore(rt.metaDsn ? new MysqlBackend(rt.metaDsn) : new SqliteBackend(join(rt.cwd, "src/server/config/ontos-meta.db")));
  return rt.meta;
}

/** 测试用：独立临时库（SQLite 后端）。 */
export function freshMetaStore(path: string): MetaStore {
  return new MetaStore(new SqliteBackend(path));
}
