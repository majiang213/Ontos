-- 元库 DDL（MySQL 方言）——建库单源：一种数据库一个文件（sqlite.sql / pg.sql 同构手写，不做字符串替换派生）。
-- 开发期不做老库迁移：结构变了删库重建；启动只跑本文件的 CREATE TABLE IF NOT EXISTS（datasource.ts 读文件下发）。
-- 注释纪律：注释只写一次，在 COMMENT 子句里（源码可读 + 进 information_schema 元数据，工具可查）；
-- sqlite.sql 没有 COMMENT 语法，同一份文本在那边是行内 -- 注释、在 pg.sql 是 COMMENT ON——三边对齐维护，sqlite 是源、本文件是投影。
-- 与 sqlite.sql 的方言差异（全部刻意，改之前先读这段）：
-- ① 自增列型 BIGINT AUTO_INCREMENT；② 浮点型 DOUBLE；
-- ③ 时间列 DATETIME DEFAULT CURRENT_TIMESTAMP（MySQL 不许 TEXT 挂这个时间默认值，错误 1067）；
-- ④ 进索引/主键/UNIQUE 的列用 VARCHAR(191)（MySQL 不许 TEXT 列无前缀长度进索引，错误 1170）；
-- ⑤ 索引内联进表定义（MySQL 没有 CREATE INDEX IF NOT EXISTS；SQLite 侧是独立语句）；
-- ⑥ COMMENT 子句是本文件的注释载体（SQLite 无此语法）；
-- ⑦ 每表 ENGINE=InnoDB DEFAULT CHARSET=utf8mb4（中文字段在非 utf8mb4 库上乱码）；
-- 另：TEXT 的默认值只许表达式形态 DEFAULT ('...')（8.0.13+），字面量形态 MySQL 拒收（错误 1101）。
-- 多语句发包靠 MysqlDatasource 建池开 multipleStatements（datasource.ts）——八个 CREATE TABLE 一次下发。

CREATE TABLE IF NOT EXISTS onto_workspace (
  id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '空间 id',
  name VARCHAR(191) NOT NULL UNIQUE COMMENT '空间名（小写字母/数字/中划线/下划线）',
  seed_from TEXT COMMENT '起步来源：template=演示模板；lazy=被元数据写抢注',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='工作空间注册表：一个空间一行，只登记身份（画布内容全在 onto_version 的工作行）';
CREATE TABLE IF NOT EXISTS onto_version (
  id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '行 id',
  workspace_id BIGINT NOT NULL COMMENT '所属空间',
  version INT COMMENT '已发布编号（首版为 1）；NULL = 工作行',
  yaml TEXT NOT NULL DEFAULT ('') COMMENT '本体 YAML 全量快照（不存增量 diff）；工作行恒空串（内容在 canvas_json）',
  canvas_json TEXT COMMENT '画布包 JSON：{ config, layout, edgeBends, edgePins }；老编号行可能没有',
  origin TEXT NOT NULL DEFAULT ('publish') COMMENT '恒 publish（工作行带默认值，不读它）；rollback 行只见于历史库',
  note TEXT COMMENT '发布说明',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  rev INT NOT NULL DEFAULT 0 COMMENT '工作行的草稿修订号（编号行恒 0，不读它）：CAS 冲突检测与 ETag 的源',
  draft_key BIGINT GENERATED ALWAYS AS (CASE WHEN version IS NULL THEN workspace_id END) VIRTUAL COMMENT '工作行唯一锚（编号行为 NULL 不参与；VIRTUAL 与 SQLite 方言对齐，只用于唯一索引）',
  UNIQUE (workspace_id, version),
  UNIQUE KEY uq_draft_key (draft_key),
  FOREIGN KEY (workspace_id) REFERENCES onto_workspace(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='版本链 + 工作行：编号行是不可变历史；version IS NULL 的是工作行（每空间恰一行的可变头）';
CREATE TABLE IF NOT EXISTS conn_source (
  id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '行 id',
  workspace_id BIGINT NOT NULL COMMENT '所属空间',
  name VARCHAR(191) NOT NULL COMMENT '连接名',
  type TEXT NOT NULL COMMENT 'mysql | pg | sqlite',
  host TEXT COMMENT '主机（sqlite 连接没有）',
  port INT COMMENT '端口',
  db_name TEXT COMMENT '库名；sqlite 连接是文件路径',
  ro_user TEXT COMMENT '只读账号：读表结构与问数用',
  ro_pass TEXT COMMENT '密码明文存（演示期；加密为后续项）',
  rw_user TEXT COMMENT '可写账号：动作写回用，可空',
  rw_pass TEXT COMMENT '密码明文存（演示期；加密为后续项）',
  options TEXT COMMENT '方言项 JSON：ssl、超时等',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最近改动时间（保存连接即刷新）',
  UNIQUE (workspace_id, name),
  FOREIGN KEY (workspace_id) REFERENCES onto_workspace(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='数据源连接：本体按 name 引用';
CREATE TABLE IF NOT EXISTS adj_decision (
  id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '行 id',
  workspace_id BIGINT NOT NULL COMMENT '所属空间',
  version INT COMMENT '结论生效的已发布版本，发布时回填',
  class_a TEXT NOT NULL COMMENT '被裁决的两个类',
  class_b TEXT NOT NULL COMMENT '被裁决的两个类',
  source_a TEXT NOT NULL COMMENT '两个类各自来自的连接',
  source_b TEXT NOT NULL COMMENT '两个类各自来自的连接',
  llm_advice TEXT COMMENT '模型建议与依据',
  rate DOUBLE COMMENT '裁决时看到的交集率',
  evidence TEXT COMMENT '证据快照 JSON：归一化规则、样本量、交集数；交集可重算，快照留裁决时点',
  verdict TEXT NOT NULL COMMENT 'same | overlap | stage | name_similar | skip（同一 | 部分重叠 | 阶段 | 仅名称相似 | 跳过）',
  decided_by TEXT NOT NULL COMMENT '裁决人',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  INDEX idx_adj_decision_ws (workspace_id),
  FOREIGN KEY (workspace_id) REFERENCES onto_workspace(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='裁决留痕：人定的，不可重算';
CREATE TABLE IF NOT EXISTS adj_overlap (
  id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '行 id',
  workspace_id BIGINT NOT NULL COMMENT '所属空间',
  class_a VARCHAR(191) NOT NULL COMMENT '被比对的两个类',
  class_b VARCHAR(191) NOT NULL COMMENT '被比对的两个类',
  norm_rule TEXT COMMENT '归一化规则',
  count_a INT NOT NULL COMMENT '两类的标识数',
  count_b INT NOT NULL COMMENT '两类的标识数',
  count_hit INT NOT NULL COMMENT '交集数',
  rate DOUBLE NOT NULL COMMENT '交集率 = |交集| / max(|A|, |B|)',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  UNIQUE (workspace_id, class_a, class_b),
  FOREIGN KEY (workspace_id) REFERENCES onto_workspace(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='交集计算记录：机器算的，可重算；只落计数，标识值集合不落盘';
CREATE TABLE IF NOT EXISTS ont_question (
  id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '行 id',
  workspace_id BIGINT NOT NULL COMMENT '所属空间',
  version INT COMMENT '最后一次跑批时的本体版本',
  question TEXT NOT NULL COMMENT '自然语言问题',
  expected TEXT COMMENT '纯数字=比对行数；字段=值=至少一行对上；留空=能查出就算过',
  status TEXT NOT NULL DEFAULT ('未跑') COMMENT '词表单源在 features/acceptance/questionStatus.ts 的 Q_STATUS（meta 不 import engine，按名互指）',
  detail TEXT COMMENT '失败原因（白话），通过时清空',
  INDEX idx_ont_question_ws (workspace_id),
  FOREIGN KEY (workspace_id) REFERENCES onto_workspace(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='验收问题集';
CREATE TABLE IF NOT EXISTS log_query (
  id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '行 id',
  workspace_id BIGINT NOT NULL COMMENT '所属空间',
  version INT COMMENT '查询依据的本体版本',
  session_id TEXT COMMENT '关联的会话',
  model TEXT COMMENT '编查询用的模型（离线回退也记）',
  question TEXT COMMENT '自然语言问题',
  query_json TEXT COMMENT '编出的结构化查询',
  row_count INT COMMENT '当时返回的行数；不是结果集',
  error TEXT COMMENT '失败原因摘要',
  duration_ms INT COMMENT '耗时（毫秒）',
  ok INT NOT NULL COMMENT '1 成 0 败',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  INDEX idx_log_query_ws_time (workspace_id, created_at),
  FOREIGN KEY (workspace_id) REFERENCES onto_workspace(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='问数留痕：存请求与成败，不存结果集';
CREATE TABLE IF NOT EXISTS log_action (
  id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '行 id',
  workspace_id BIGINT NOT NULL COMMENT '所属空间',
  version INT COMMENT '动作依据的本体版本',
  action TEXT NOT NULL COMMENT '动作名',
  object_type TEXT NOT NULL COMMENT '类名',
  subject TEXT NOT NULL COMMENT '请求点名的个体识别值',
  request_json TEXT COMMENT '请求参数',
  projections TEXT COMMENT '各条写回的成败 JSON；演示期不拆子表',
  error TEXT COMMENT '前置/公理拒绝的原因；拒绝发生在写回之前',
  duration_ms INT COMMENT '耗时（毫秒）',
  ok INT NOT NULL COMMENT '1 成 0 败',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  INDEX idx_log_action_ws_time (workspace_id, created_at),
  FOREIGN KEY (workspace_id) REFERENCES onto_workspace(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='动作留痕';
