// 元库 DDL（MySQL 方言）——建库单源：一种数据库一个文件（sqlite.ts 同构手写，不做字符串替换派生）。
// 不兼容旧库：老库直接删掉重建。与 sqlite.ts 的差异只三处：自增列型、时间默认值、浮点型。

export const MYSQL_DDL = `
CREATE TABLE IF NOT EXISTS onto_workspace (   -- 工作空间注册表：一个空间一行，只登记身份（画布内容全在 onto_version 的工作行）
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  name TEXT NOT NULL UNIQUE,                  -- 空间名（小写字母/数字/中划线/下划线）
  seed_from TEXT,                             -- 起步来源：template=演示模板；lazy=被元数据写抢注
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS onto_version (     -- 版本链 + 工作行：编号行是不可变历史；version IS NULL 的是工作行（每空间恰一行的可变头）
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  workspace_id BIGINT NOT NULL,
  version INT,                                -- 已发布编号（首版为 1）；NULL = 工作行
  yaml TEXT NOT NULL DEFAULT (''),            -- 本体 YAML 全量快照（不存增量 diff）；工作行恒空串（内容在 canvas_json）
  canvas_json TEXT,                           -- 画布包 JSON：{ config, layout, edgeBends, edgePins }；老编号行可能没有
  origin TEXT NOT NULL DEFAULT 'publish',     -- 恒 publish（工作行带默认值，不读它）；rollback 行只见于历史库
  note TEXT,                                  -- 发布说明
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, version)
);
CREATE TABLE IF NOT EXISTS conn_source (      -- 数据源连接：本体按 name 引用
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  workspace_id BIGINT NOT NULL,
  name TEXT NOT NULL,                         -- 连接名
  type TEXT NOT NULL,                         -- mysql | pg | sqlite
  host TEXT,
  port INT,
  db_name TEXT,
  ro_user TEXT,                               -- 只读账号：读表结构与问数用
  ro_pass TEXT,                               -- 密码明文存（演示期；加密为后续项）
  rw_user TEXT,                               -- 可写账号：动作写回用，可空
  rw_pass TEXT,                               -- 密码明文存（演示期；加密为后续项）
  options TEXT,                               -- 方言项 JSON：ssl、超时等
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, name)
);
CREATE TABLE IF NOT EXISTS adj_decision (     -- 裁决留痕：人定的，不可重算
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  workspace_id BIGINT NOT NULL,
  version INT,                                -- 结论生效的已发布版本，发布时回填
  class_a TEXT NOT NULL,                      -- 被裁决的两个类
  class_b TEXT NOT NULL,
  source_a TEXT NOT NULL,                     -- 两个类各自来自的连接
  source_b TEXT NOT NULL,
  llm_advice TEXT,                            -- 模型建议与依据
  rate DOUBLE,                                -- 裁决时看到的交集率
  evidence TEXT,                              -- 证据快照 JSON：归一化规则、样本量、交集数；交集可重算，快照留裁决时点
  verdict TEXT NOT NULL,                      -- same | overlap | stage | name_similar | skip（同一 | 部分重叠 | 阶段 | 仅名称相似 | 跳过）
  decided_by TEXT NOT NULL,                   -- 裁决人
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS adj_overlap (      -- 交集计算记录：机器算的，可重算；只落计数，标识值集合不落盘
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  workspace_id BIGINT NOT NULL,
  class_a TEXT NOT NULL,                      -- 被比对的两个类
  class_b TEXT NOT NULL,
  norm_rule TEXT,                             -- 归一化规则
  count_a INT NOT NULL,                       -- 两类的标识数
  count_b INT NOT NULL,
  count_hit INT NOT NULL,                     -- 交集数
  rate DOUBLE NOT NULL,                       -- 交集率 = |交集| / max(|A|, |B|)
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, class_a, class_b)     -- 按对一行（并发重算不双行，upsert 落点）
);
CREATE TABLE IF NOT EXISTS ont_question (     -- 验收问题集
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  workspace_id BIGINT NOT NULL,
  version INT,                                -- 最后一次跑批时的本体版本
  question TEXT NOT NULL,                     -- 自然语言问题
  expected TEXT,                              -- 纯数字=比对行数；字段=值=至少一行对上；留空=能查出就算过
  status TEXT NOT NULL DEFAULT '未跑',        -- 未跑 / 通过 / 编译失败 / 执行出错 / 答案不符
  detail TEXT                                 -- 失败原因（白话），通过时清空
);
CREATE TABLE IF NOT EXISTS log_query (        -- 问数留痕：存请求与成败，不存结果集
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  workspace_id BIGINT NOT NULL,
  version INT,                                -- 查询依据的本体版本
  session_id TEXT,                            -- 关联的会话
  model TEXT,                                 -- 编查询用的模型（离线回退也记）
  question TEXT,                              -- 自然语言问题
  query_json TEXT,                            -- 编出的结构化查询
  row_count INT,                              -- 当时返回的行数；不是结果集
  error TEXT,                                 -- 失败原因摘要
  duration_ms INT,                            -- 耗时（毫秒）
  ok INT NOT NULL,                            -- 1 成 0 败
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS log_action (       -- 动作留痕
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  workspace_id BIGINT NOT NULL,
  version INT,                                -- 动作依据的本体版本
  action TEXT NOT NULL,                       -- 动作名
  object_type TEXT NOT NULL,                  -- 类名
  subject TEXT NOT NULL,                      -- 请求点名的个体识别值
  request_json TEXT,                          -- 请求参数
  projections TEXT,                           -- 各条写回的成败 JSON；演示期不拆子表
  error TEXT,                                 -- 前置/公理拒绝的原因；拒绝发生在写回之前
  duration_ms INT,                            -- 耗时（毫秒）
  ok INT NOT NULL,                            -- 1 成 0 败
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS meta_seq (         -- 发号器：generate 的 sequence 片段按名取号
  workspace_id BIGINT NOT NULL,
  name TEXT NOT NULL,                         -- 序列名（如 appt_no）；按空间分开，各自起号
  value INT NOT NULL,                         -- 当前已发到几号
  PRIMARY KEY (workspace_id, name)
);
`;
