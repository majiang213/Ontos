# Ontos（安托斯）

把一份可发布的本体盖在已有数据库上：不搬数据、不造新库、本期不出码。读和写都先经过本体，再落回原来的库。换领域只换这份配置，引擎不动。

## 它做什么

- **逆向建模**：接上源库，读取表结构，生成本体对象上画布。
- **跨源整合**：对疑似同一批现实实体的两个类，由人裁决关系类型（同一 / 部分重叠 / 阶段 / 仅名称相似）。
- **问数与动作**：外部 Agent 经 MCP 按已发布本体查数、执行动作；写入按映射投影回原表。
- **数据留在源库**：平台只存本体、映射、裁决留痕；交集在内存里算，标识集合不落盘。

演示空间 `test` 带一套现成本体与 fixture 连接；`default` 和新建空间都是空白画布，从连接数据源开始。

## 快速开始

需要 Node ≥ 22.5（本机 SQLite 走内置的 `node:sqlite`）。

```bash
npm install
cp .env.example .env   # 按需填写；不设也能跑
npm run dev            # http://localhost:6688
npm test
```

浏览器打开后，左上角切到 `test` 看演示，或留在 `default` 从零接库。不配模型 Key 时，生成对象和问数走离线回退；`test` 的演示数据与是否配 Key 无关。本地用浏览器操作时不要设 `ONTOS_TOKEN`，否则画布写请求会 401。

生产启动：`npm run build && npm start`（端口同样是 6688）。

### 三波走查（真模型演示）

完整剧本在 [docs/真模型端到端测试.md](docs/真模型端到端测试.md)。入口：

1. 配真模型三件套 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`（不配时离线回退只够证明「连得上、表在、列注释在」，空白空间的生成、裁决建议、问题集跑批都必须真模型）；不要设 `ONTOS_TOKEN`。
2. `npm run demo:seed` —— 把十二套演示系统写成 `.ontos-demo/` 下的 SQLite 文件（幂等，不进 git）。打印出来的十二行就是连接表单该填的答案：给人看的名字、连接名、类型「SQLite 文件（演示）」、绝对路径（表单默认下拉选择演示库文件，绝对路径留作手动模式核对）。
3. `npm run dev` 后**新建空白工作空间**（不要用 `test`——那是附录 C 的演示世界，在役 97；走查世界在役 100），按「物 → 人 → 客与货」三波接入、生成、裁决、发布，每波用「验收问题集」卡的「换成第 N 波问题」→「全量跑一遍」收口，全绿再进下一波。

`npm test` 始终离线（套件启动即剥掉模型 Key 与写令牌），随时可跑。

## 配置

复制 `.env.example` 为 `.env`。全部可选。Next.js 会加载根目录 `.env`。

| 变量 | 作用 | 缺省 |
|---|---|---|
| `OPENAI_API_KEY` | 接真模型（OpenAI 兼容协议）。问数编译、逆向建模、疑似重复建议三个槽位从离线回退切到真模型 | 不设 = 离线回退。问数剧本只覆盖 `test`；生成对象与候选对建议是通用启发式，各空间都能用。演示数据不按 Key 判断 |
| `OPENAI_MODEL` | 真模型名。设了 `OPENAI_API_KEY` 则必填 | 不设且配了 Key = 启动报错 |
| `OPENAI_BASE_URL` | OpenAI 兼容接入点（含内部网关）。填基址，SDK 自己拼 `/chat/completions`——别把全路径抄进来 | `https://api.x.ai/v1` |
| `ONTOS_TOKEN` | 写端点令牌。连接 / 发布 / 裁决 / 动作等写库请求需 `Authorization: Bearer <token>` | 不设 = 不验令牌。本地浏览器走查不要设 |
| `ONTOS_META_DSN` | 平台元库。`mysql://…` 走 MySQL；`postgres://…` / `postgresql://…` 走 PostgreSQL | 不设 = 本地 SQLite `src/server/config/ontos-meta.db` |
| `ONTOS_SNOWFLAKE_INSTANCE_ID` | 雪花号实例位，取值 0–1023。多实例部署时，同一份 MySQL/PG 元库下每实例一个不重复的值 | 不设 = 随机派生（单实例无所谓） |

多实例必须把元库换成 MySQL 或 PostgreSQL，并给每实例分配 `ONTOS_SNOWFLAKE_INSTANCE_ID`。SQLite 单文件不能多实例共享。`test` 空间的 fixture 各实例各自播种，多实例下对它的写会分叉。

## 用法

画布是唯一页面：连接数据源 → 勾表生成对象 → 有疑似重复就裁决 → 发布。问数和动作没有站内对话框。

外部 Agent 走 MCP：

```
POST http://localhost:6688/api/<空间名>/mcp
```

演示用 `/api/test/mcp`。协议是 JSON-RPC 2.0。配套 skill 在 `skills/`：

| Skill | 做什么 |
|---|---|
| [`ontos-query`](skills/ontos-query/SKILL.md) | 按已发布本体查数 |
| [`ontos-action-run`](skills/ontos-action-run/SKILL.md) | 按已发布本体执行动作 |
| [`ontos-canvas`](skills/ontos-canvas/SKILL.md) | 改草稿画布 |
| [`ontos-action`](skills/ontos-action/SKILL.md) | 写动作定义 |

设了 `ONTOS_TOKEN` 时，`edit_draft` 和 `run_action` 必须带 Bearer 令牌。

## 工作原理

本体是一份 YAML：领域里有哪些类、类上有哪些属性、类之间有哪些关系、凭什么认同一条记录。发布之后，问数和动作都读这份已发布快照。

引擎按源映射把请求下推到各源库，在内存里按识别字段把多源行对齐到同一个体。写入先核前置、再按效应改存在，最后按映射写回原表。配置里没有的定义，引擎拒绝。

两个源上的类先判定关系，再决定怎么进同一份本体。模型只看表结构给建议，定案永远是人。五种结论：同一、部分重叠、阶段、仅名称相似、子类型（本期预留）。

## 文档

| 文件 | 内容 |
|---|---|
| [docs/ontos-article.md](docs/ontos-article.md) | 概念与配置骨架（引擎按附录执行） |
| [docs/Ontology平台MVP设计文档.md](docs/Ontology平台MVP设计文档.md) | 产品定位、架构、元模型、红线 |
| [AGENTS.md](AGENTS.md) | 仓库约定：用语、术语、代码结构纪律 |

## 局限

配置是 YAML 不是 OWL，没有推理机。跨源对齐在引擎内存里做，规模受限。不做跨库分布式事务，失败靠重发与人工修。模型的比对建议不准，所以定案权在人。

## 开发

改引擎或配置骨架先跑 `npm test`。贡献约定见 [AGENTS.md](AGENTS.md)。

前后端一体（Next.js 16 + React 19）。源库驱动是 `mysql2` / `pg` / `node:sqlite`；平台元库默认 SQLite，可用 `ONTOS_META_DSN` 换成 MySQL 或 PostgreSQL。
