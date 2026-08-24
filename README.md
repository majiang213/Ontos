# Ontos（安托斯）

通用 Ontology 平台的设计文档与 MVP 实现。核心想法：把一份可发布的本体（YAML 配置）盖在已有数据库之上——不迁移、不复制业务数据，读和写都先经过本体，再落回原来的库。换领域只换这份配置，引擎不动。

## 本体是什么

本体把一个领域的概念化明确写出来：领域里有什么**类**（人、设备、订单），类上有什么**属性**，类之间有什么**关系**，凭什么说两条记录指向同一个体（**同一性标准**，界面上叫识别字段）。本体规定「有什么」，不规定某张表怎么建。

## 本体怎么作用于已有系统

本体自己是描述性的，不会读数据也不会改数据。要作用于已有系统，需补三样：

- **源映射**：把类和属性对到具体的连接、表、列——本体和现实之间的桥。
- **动作**：写入落成三段式。前置：变化发生前个体必须满足什么；效应：存在上变成什么；写回：按源映射把变化投影到源表。
- **引擎**：本体的运行时。加载已发布的配置，按配置求值查询与动作；配置里没有的定义，引擎拒绝。引擎源码里不含任何领域概念。

## 跨源整合：先判定再合并

每个系统只存现实的一个侧面，各起各的名字。两个源上的类之间是什么关系，必须先判定，再决定怎么进同一份本体。结论五种：同一（合并为一个类、挂多个源）、部分重叠（公共部分立上位对象）、阶段（统一成一个类，阶段是派生属性，转化由动作记录）、仅名称相似（各自独立）、子类型（本期预留）。

判定分三步：

1. **结构比对**：语言模型只看表结构（名字、字段、字段类型），给出候选对和倾向，不定案。
2. **交集率**：对候选对两端的识别字段统一格式后算取值交集，回答「两库记录是不是同一批现实实体」。
3. **人工裁决**：前两步只是建议，定案永远是人。裁决留痕，发布可回滚。

## 查询与写入

- **查询**：以类为根的树形请求（过滤、按关系展开、分组统计）。引擎按源映射下推各源，在内存里按同一性标准把多源行对齐到同一个体。自然语言由 Agent 编成结构化请求，引擎确定性编译、全程只读。
- **写入**：请求只点名类、个体、动作名。引擎核前置、按效应定变化、校验公理，再按源映射写回源表。没有经过逆向建模、没有映射的系统走告知：把这次变更收成一条事件外发。

## 数据承诺

不迁移、不复制业务数据；交集率在内存里算，标识集合不落地；查询实时只读查源库；写入只按已发布动作投影回原库；采样脱敏。数据始终留在源库。

## 局限

配置是 YAML 不是 OWL，没有推理机；跨源对齐在引擎内存里做，规模受限；不做跨库分布式事务，失败靠重发与人工修；模型的比对建议准确率有限，所以定案权在人。

## 仓库内容

| 文件 | 内容 |
|---|---|
| `docs/ontos-article.md` | 概念长文：本体论要素、本体与已有系统、跨源对齐方法论、查询与写入的求值过程、局限、配置附录 |
| `docs/Ontology平台MVP设计文档.md` | MVP 设计文档：产品定位、系统架构、元模型骨架、计划与红线 |
| `AGENTS.md` | 仓库工作约定：语言规则、术语表、交互架构约定 |
| `skills/` | 给外部 Agent（Claude Code 等 ReAct 循环）的接入技能，按「世界 × 读写」分四个自包含目录：`ontos-query`（已发布·查数）、`ontos-action-run`（已发布·执行动作）、`ontos-canvas`（草稿·改画布）、`ontos-action`（草稿·写动作定义） |
| `src/` | Next.js 应用（前后端一体）：页面与路由 `src/app/`、前端组件 `src/components/`、引擎 `src/server/engine/`、测试 `src/tests/` |

## 代码结构

```
src/
├── app/                    Next.js App Router（前后端一体）
│   ├── page.tsx            入口：空间切换 + 画布页
│   ├── globals.css         全部样式（设计 token + 组件类）
│   └── api/                14 个路由：query（执行结构化查询）、
│                           apply_draft（写工作副本）、publish（发布）、
│                           generate_objects（AI 生成对象）、list_tables（读表结构）、
│                           list_candidates / compute_overlap / decide（整合三步）、
│                           connections / workspaces、ontology / versions、
│                           questions、mcp（外部 Agent 入口）
├── components/             CanvasPage.tsx（构建页壳：状态机与工具条）、
│                           canvas/（OntologyCanvas、FloatingEdge / FloatingConnectionLine、layout 分层布局、router 走线）、
│                           cards/（Bezel 卡面壳、ObjectCard 对象编辑卡、LinkDetailCard 关系详情、
│                           VersionsCard 版本历史、PairCard 裁决面板、QuestionsCard 验收问题集卡、SchemaDrawer 表结构抽屉）、
│                           forms/（forms 连接/新建对象/字段表单、ActionForm 动作表单、actionView 动作区纯函数）、
│                           ontFrame.ts（帧→视图模型：轮询 toast、收卡策略、版本/发布钮文案）、
│                           revWatcher.ts（轮询纪律）、wsClient.ts（API 适配器）
├── server/                 后端：引擎、校验、元库、运行态、种子配置
│   ├── engine/             引擎，按关切分子包：
│   │   ├── query/          问数：query（投影结果树）、individual（个体核心类型与源列取值）、
│   │   │                   assemble（下推对齐组装 + createEnv）、evaluate（when/派生/过滤求值）、
│   │   │                   compare（行级比较与过滤形状校验）、expr（表达式）、
│   │   │                   filterOp（过滤运算符表）、questions（验收跑批：失败分阶段 + 期望比对）
│   │   ├── action/         动作执行（核前置、定效应、写回、留痕）
│   │   ├── config/         configStore（工作副本与已发布的唯一出入口）、applyOp（编辑操作落草稿）、
│   │   │                   pack（画布快照打包）、refs（删除前的引用扫描）、validate（语义校验 + 动作形状四查）、
│   │   │                   skeletons（set_fields 骨架与级联）、views（配置三视图）、lineage（列→属性反查）
│   │   ├── adjudication/   adjudicate（裁决落地 + 转化骨架）、pairs（裁决流水线：候选/交集率/定案）、
│   │   │                   eligibility（候选对资格谓词）、overlap / normalize（交集率与归一化）、
│   │   │                   verdict（五关系类型枚举与倾向文案）
│   │   ├── infra/          driver（源驱动接口 + 方言）、fixture / sqlDriver（两种实现）、
│   │   │                   registry / load（驱动注册表 + 连接保存/删除生命周期）、
│   │   │                   logging（问数/动作留痕编排）、workspace（工作空间）
│   │   └── llmSlot.ts      模型槽位 + 离线回退
│   ├── schema/             Zod 形状：config（本体配置）、request（问数/动作请求）、ops（编辑操作）
│   │   └── spec/           形状规约：filterSpec（$link 过滤树的唯一遍历入口与关系解析）、
│   │                       valueSpec（取值来源原语：{ from: X } 词表的唯一事实源）、
│   │                       actionSpec（动作形状规约：位置规则、表单子集、效应种类/取值位置走查）
│   ├── meta/               平台元数据库：store.ts（门面）+ backends.ts（SQLite / MySQL 两种后端，ONTOS_META_DSN 切换）
│   │                       + types.ts + stores/（工作空间/版本链/连接/裁决/问题集/留痕/序号 七个关切存储）
│   ├── runtime.ts          运行态（元库/注册表/配置存储的进程级单例，测试可整套换掉）
│   └── config/             ontology.yaml（演示模板）与 ontos-meta.db（元库文件）
└── tests/                  vitest；引擎行为约定钉在测试里
```

四条主线：

- **建模流**：画布操作 → `POST /api/apply_draft` 写工作副本 → `publish` 走 `validate` 校验 → `configStore` 插新版本。画布读工作副本，问数与动作只读已发布快照。外部 Agent 也能经 MCP 的 `apply_draft` 写工作副本（带 `base_rev` 防盖写），开着的画布每 2 秒轮询 `/api/ontology` 的 `rev`（ETag/304），外部改动自动刷新并弹提示。
- **问数流**：外部 Agent 走 `mcp` 路由的 `query` 工具（用法见 `skills/ontos-query/SKILL.md`）；站内只剩验收跑批（`questions?run=1` → `engine/query/questions`）→ `llmSlot` 产结构化查询（无 key 走离线回退）→ `schema/request` 校验 → `query` 编译下推 → `load` 按连接名找驱动 → 源库取数，内存对齐。
- **动作流**：外部 Agent 走 `mcp` 路由的 `run_action` 工具（用法见 `skills/ontos-action-run/SKILL.md`）→ `engine/action` 核前置、定效应、按 `project` 写回源库并留痕。
- **边界**：业务数据永不进平台，引擎只在内存拼装；`src/server/config` 里只有本体模板和平台自己的元库。

## 接口一览

URL 没有注册表：文件路径即路由（`src/app/api/ontology/route.ts` 就是 `/api/ontology`），前端在组件里写字符串字面量，经 `wsClient.ts` 一道接缝拼 `?ws=` 发出。路由是薄壳（解析 → 调引擎 → 出 JSON），逻辑全在 `src/server/engine/`。

### 数据源接入

| 接口 | 描述 | 前端调用处 |
|---|---|---|
| `/api/connections` GET/POST/DELETE | 连接管理：列表（剥掉密码）、保存（先测连通再落库）、删除 | `forms.tsx`（仅 POST） |
| `/api/list_tables` GET | 表结构内省：每个连接的表定义（列名/类型/主键/中文注释） + 3 行脱敏采样，源表只读 | `CanvasPage.tsx`（两处） |

### 本体构建（画布页）

| 接口 | 描述 | 前端调用处 |
|---|---|---|
| `/api/generate_objects` POST | 逆向建模：选中的表 → 内省 → LLM 产草稿 → 对象以草稿态上画布，每个新类自动带一条 `set_fields` 动作 | `CanvasPage.tsx` |
| `/api/ontology` GET | 本体视图：画布读工作副本，`states` 标出新增/改过/一致；带 `rev` 与 `action_changes`（动作差集），支持 ETag/304——画布每 2 秒轮询它当监视器 | `CanvasPage.tsx` |
| `/api/apply_draft` POST | 工作副本编辑：形状不合法 400，操作不合法（重名、被引用等）422 | `CanvasPage.tsx` |
| `/api/publish` POST/DELETE | 发布草稿（升版本、立即可查）/ 放弃草稿回退到已发布快照 | `CanvasPage.tsx` |
| `/api/versions` GET/POST | 版本历史列表 / 把指定版覆盖到当前工作副本（不插入新版本） | `CanvasPage.tsx` |

### 跨源整合（裁决三步，画布上的卡片）

| 接口 | 描述 | 前端调用处 |
|---|---|---|
| `/api/list_candidates` GET | 候选对：已上画布对象之间找跨源候选配对，附倾向与依据 | `CanvasPage.tsx` |
| `/api/compute_overlap` POST | 交集率：归一化后算两类识别字段的集合重合度，只读采样 | `PairCard.tsx` |
| `/api/decide` POST | 裁决：人对候选对定案（五种结论），写草稿 + 留痕（含证据快照） | `PairCard.tsx` |

### 问数与动作（对外执行入口，前端不调）

| 接口 | 描述 | 前端调用处 |
|---|---|---|
| `/api/mcp` POST | MCP 端点：JSON-RPC 2.0，外部 Agent 调 Ontos 工具（initialize / tools/list / tools/call）；九个工具：query / run_action / propose_objects / propose_action / list_classes / read_class / search / list_tables / apply_draft。发现类工具可选 `space: "draft"` 读工作副本（缺省已发布）；`apply_draft` 写工作副本（必带 `base_rev`）。用法见 `skills/` 四个目录 | 无——外部 Agent 用 |
| `/api/query` POST | 查询服务：直接执行结构化查询 JSON，返回答案行 + 取数路径 + 留痕 | 无——REST 形态的只读入口 |

### 验收

| 接口 | 描述 | 前端调用处 |
|---|---|---|
| `/api/questions` GET/POST/DELETE | 验收问题集：增删查，GET 带当前已发布版本；POST `?run=1` 全量跑一遍（body `{ id }` 只跑一条）。期望结果两种写法：纯数字（比对行数）或 `字段=值`；失败分阶段记（编译失败/执行出错/答案不符），原因落 `detail` | `QuestionsCard.tsx` |

### 空间管理

| 接口 | 描述 | 前端调用处 |
|---|---|---|
| `/api/workspaces` GET/POST | 空间列表 / 从空白模板新建空间，版本链按空间隔离 | `app/page.tsx` |



## 代码阅读入口

按下面的顺序读，半小时能建立全貌。每个文件头部注释先写职责，先看注释再读实现。

1. `src/server/config/ontology.yaml` 配 `src/server/schema/config.ts`：先读本体的真实形状和它的校验，知道引擎在执行什么。
2. `src/server/engine/infra/driver.ts`：引擎与源库之间的唯一接口。再看 `fixture.ts`（内存实现，演示与测试都靠它）和 `sqlDriver.ts`（MySQL/PG 实现），同在 `infra/`。
3. `src/server/engine/query/individual.ts` 配 `query/query.ts`：读个体（下推、对齐、派生）在 individual；问数树投影在 query。
4. `src/server/engine/action/action.ts`：写的路径——前置、效应、投影、留痕；读个体走 individual，不经过 query。
5. `src/server/engine/config/configStore.ts` 配 `src/server/meta/store.ts`：工作副本、已发布、版本链怎么存。引用扫描在 `config/refs.ts`（纯函数），资格谓词在 `adjudication/eligibility.ts`，进程级单例收口在 `runtime.ts`。
6. `src/app/api/mcp/route.ts` 配 `tools.ts` 与 `skills/`（四个目录）：外部 Agent 的完整入口——route 只剩信封与调度，九个工具登记在 tools.ts 一张表（说明/inputSchema/space/令牌/handler），skill 正文是调用方法论。
7. `src/tests/engine.test.ts`：引擎的行为约定。改引擎先跑 `npm test`，全绿再谈别的。

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 框架 | Next.js 16（App Router）+ React 19 + TypeScript 7（strict） | 前后端一体，页面与 API 同在 `src/app` |
| 样式 | 手写 CSS | 无 Tailwind、无 CSS-in-JS；设计 token 与组件类在 `globals.css`，组件内联样式补局部 |
| 画布 | @xyflow/react（ReactFlow 12）+ @dagrejs/dagre | 本体画布；dagre 负责自动分层布局 |
| 校验 | Zod 4 | 本体配置、问数/动作请求、编辑操作三套 schema；模型产出也过同一套 |
| 模型 | Vercel AI SDK（`ai` + `@ai-sdk/xai`，OpenAI 兼容） | 只在 `llmSlot` 的三个槽位出现；不设 key 走离线确定性回退 |
| 源库驱动 | `mysql2`、`pg`、`node:sqlite`（DatabaseSync） | 真源库走 mysql2/pg；演示 fixture 与平台元库走 node:sqlite |
| 状态 | React 自带 useState / useRef | 无状态库 |
| 测试 | vitest 4（pool: forks） | 引擎 golden 测试 + schema 契约测试，254 个用例 |
| 图标 | @phosphor-icons/react | |

## 运行

需要 Node ≥ 22.5（`node:sqlite` 从该版本起内置）。

```bash
npm install
npm run dev    # 浏览器打开 http://localhost:6688（端口固定，不再改）
npm test       # 引擎 golden 测试（vitest）
```

### 可选环境变量

| 变量 | 作用 | 缺省 |
|---|---|---|
| `OPENAI_API_KEY` | 接真模型（OpenAI 兼容协议，通用键，同 Claude Code / Codex 惯例）：问数编译、逆向建模、疑似重复建议三个槽位从离线回退切换成真模型 | 不设 = 离线确定性回退（演示四问可用） |
| `OPENAI_BASE_URL` / `OPENAI_MODEL` | 换接入点/模型（任何 OpenAI 兼容端点均可，含内部网关）；`OPENAI_MODEL` 必填，不设报错 | `https://api.x.ai/v1`（BASE_URL） |
| `ONTOS_TOKEN` | 写端点令牌闸（连接/发布/裁决/动作等要写库的 API 需 `Authorization: Bearer <token>`） | 不设 = 演示模式全放开 |
