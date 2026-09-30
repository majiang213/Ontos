# Ontos（安托斯）

> 现有数据库之上的 AI 读写中间层：从表归纳本体，按证据整合多源，在原库上问数和执行受控动作。

## 它解决什么问题

企业的采购、设备、资产、办公等系统通常各自保存一部分事实。Ontos 不搬走业务数据，也不生成一套新的 CRUD 应用，而是把跨系统的共同理解写成可发布、可回滚的本体：

1. 连接 MySQL、PostgreSQL 或 SQLite 文件，读取表结构和脱敏采样。
2. Agent 从表归纳对象，按同一性标准和交集证据整合多源；结果落工作副本。
3. 人在画布上审查并发布；问数读已发布版本，动作按已发布定义写回源库。

同一概念的表并成一个多源类；不同概念之间才建带领域谓词的关联链。类间判定与问数时的多源行配对不是同一件事，完整定义见 [CONTEXT.md](CONTEXT.md)。

## 当前形态

- 对外主入口是 MCP：查询、动作、建模建议、草稿编辑和本体读取等边界工具都走确定性校验。
- 查询按已发布本体下推各源，在内存中按 `identity` / 源条目的 `key` 配成同一个体；平台不存业务行。
- 动作按 `pre`、公理和 `effect` 执行，写回目标由本体的 `sources` 推出；跨库不伪装成分布式事务。
- 工作副本、画布状态、裁决记录、验收问题和日志在平台元库；业务数据仍在源库。
- 服务可无状态部署：本地默认 SQLite，生产可切换 MySQL/PostgreSQL 元库，并用修订号 CAS 保护并发编辑。

产品边界、模块、元库和工作空间的唯一总览见 [docs/system-architecture.md](docs/system-architecture.md)。配置键、请求形状和完整 YAML 实例见 [docs/ontology-reference.md](docs/ontology-reference.md)。

## 十分钟启动

需要 Node ≥ 22.5：

```bash
npm install
cp .env.example .env
npm run demo:seed
npm run dev
```

打开 `http://localhost:6688`，切到 `test` 工作空间即可体验演示模板和 fixture。真实模型走查需要设置 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`，步骤见 [docs/真模型端到端测试.md](docs/真模型端到端测试.md)。浏览器操作不要设置 `ONTOS_TOKEN`，否则画布写请求会被拒绝。

生产启动：

```bash
npm run build && npm start
```

## 外部 Agent 入口

```text
POST http://localhost:6688/api/<空间名>/mcp      # MCP / JSON-RPC 2.0
POST http://localhost:6688/api/<空间名>/query    # 只读查询 REST 入口
```

配套操作手册：[`ontos-query`](skills/ontos-query/SKILL.md)、[`ontos-action-run`](skills/ontos-action-run/SKILL.md)、[`ontos-canvas`](skills/ontos-canvas/SKILL.md)、[`ontos-action`](skills/ontos-action/SKILL.md)。

## 文档入口

完整分层和文件清单见 [docs/README.md](docs/README.md)。按问题选择：

| 问题 | 入口 |
|---|---|
| 术语是什么意思、哪些能力现行 | [CONTEXT.md](CONTEXT.md) |
| 仓库和 Agent 应如何工作 | [AGENTS.md](AGENTS.md) |
| 系统如何组成、数据放在哪里 | [docs/system-architecture.md](docs/system-architecture.md) |
| YAML、查询、动作怎么写 | [docs/ontology-reference.md](docs/ontology-reference.md) |
| 怎样走一遍完整链路 | [docs/真模型端到端测试.md](docs/真模型端到端测试.md) |
| 为什么作出某个局部设计 | [docs/adr/](docs/adr/) |
| 哪些是历史研究或审计材料 | [docs/research/](docs/research/) |

## 许可证

Copyright (C) 2026 MJ

本项目以 [GNU Affero 通用公共许可证第 3 版](LICENSE)（AGPL-3.0-or-later）发布。
