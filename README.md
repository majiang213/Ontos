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
| `src/` | Next.js 应用（前后端一体）：页面与路由 `src/app/`、前端组件 `src/components/`、引擎 `src/server/engine/`、测试 `src/tests/` |

## 代码结构

```
src/
├── app/                    Next.js App Router（前后端一体）
│   ├── page.tsx            入口：空间切换 + 页面分段控件
│   ├── globals.css         全部样式（设计 token + 组件类）
│   └── api/                16 个路由：ask（问数）、query（执行结构化查询）、
│                           action（动作）、draft（写工作副本）、publish（发布）、
│                           generate（AI 生成草稿）、introspect（读表结构）、
│                           candidates / overlap / decisions（整合三步）、
│                           connections / workspaces、ontology / versions、
│                           questions / saved-queries、mcp（外部 Agent 入口）
├── components/             CanvasPage（构建页）、ChatPage（对话页）、
│                           OntologyCanvas（画布）、PairCard（裁决面板）、
│                           QuestionsCard、forms（连接/新建对象表单）、Bezel（卡面壳）、
│                           sessionStore（会话模型）、shapeAnswerRows（答案卡塑形）、
│                           layout.ts（dagre 自动分层布局）、wsClient（API 适配器）
├── server/                 后端：引擎、校验、元库、运行态、种子配置
│   ├── engine/             引擎：
│   │                       driver（源驱动接口 + 方言）、fixture / sqlDriver（两种实现）、
│   │                       registry / load（驱动注册表）、query（问数执行）、
│   │                       action（动作执行）、individual（个体组装与派生）、
│   │                       adjudicate（裁决落地 + 转化骨架）、overlap / normalize（交集率与归一化）、
│   │                       configStore（工作副本与已发布的唯一出入口）、
│   │                       refs（删除前的引用扫描）、eligibility（候选对资格谓词）、
│   │                       workspace（工作空间）、llmSlot（模型槽位 + 离线回退）、
│   │                       logging（问数/动作留痕编排）、expr（表达式）、
│   │                       validate（语义校验）、views（配置三视图）
│   ├── schema/             Zod 形状：config（本体配置）、request（问数/动作请求）、ops（编辑操作）
│   │                       filterWalk（$link 过滤树的唯一遍历入口与关系解析）
│   ├── meta/store.ts       平台元数据库（默认单文件 SQLite，ONTOS_META_DSN 可换 MySQL）
│   ├── runtime.ts          运行态（元库/注册表/配置存储的进程级单例，测试可整套换掉）
│   └── config/             ontology.yaml（演示模板）与 ontos-meta.db（元库文件）
└── tests/                  12 个 vitest 文件、159 个用例；引擎行为约定钉在测试里
```

四条主线：

- **建模流**：画布操作 → `POST /api/draft` 写工作副本 → `publish` 走 `validate` 校验 → `configStore` 插新版本。画布读工作副本，问数与动作只读已发布快照。
- **问数流**：`ask` 路由 → `llmSlot` 产结构化查询（无 key 走离线回退）→ `schema/request` 校验 → `query` 编译下推 → `load` 按连接名找驱动 → 源库取数，内存对齐。
- **动作流**：`action` 路由 → `engine/action` 核前置、定效应、按 `project` 写回源库并留痕；外部 Agent 走 `mcp` 路由进同一个执行器。
- **边界**：业务数据永不进平台，引擎只在内存拼装；`src/server/config` 里只有本体模板和平台自己的元库。

## 代码阅读入口

按下面的顺序读，半小时能建立全貌。每个文件头部注释先写职责，先看注释再读实现。

1. `src/server/config/ontology.yaml` 配 `src/server/schema/config.ts`：先读本体的真实形状和它的校验，知道引擎在执行什么。
2. `src/server/engine/driver.ts`：引擎与源库之间的唯一接口。再看 `fixture.ts`（内存实现，演示与测试都靠它）和 `sqlDriver.ts`（MySQL/PG 实现）。
3. `src/server/engine/query.ts` 配 `individual.ts`：读的路径——下推、对齐、派生。
4. `src/server/engine/action.ts`：写的路径——前置、效应、投影、留痕。
5. `src/server/engine/configStore.ts` 配 `src/server/meta/store.ts`：工作副本、已发布、版本链怎么存。引用扫描在 `refs.ts`（纯函数），资格谓词在 `eligibility.ts`，进程级单例收口在 `runtime.ts`。
6. `src/app/api/ask/route.ts` 到 `src/components/ChatPage.tsx`：一条请求从路由到界面的完整走法。
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
| 状态 | React 自带 useState / useRef | 无状态库；对话会话按工作空间存 localStorage |
| 测试 | vitest 4（pool: forks） | 引擎 golden 测试 + schema/会话契约测试，159 个用例 |
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
| `XAI_API_KEY` | 接真模型（xAI，OpenAI 兼容）：问数编译、逆向建模、疑似重复建议三个槽位从离线回退切换成真模型 | 不设 = 离线确定性回退（演示四问可用） |
| `ONTOS_LLM_BASE_URL` / `ONTOS_LLM_MODEL` | 换接入点/模型 | `https://api.x.ai/v1` / `grok-4.5` |
| `ONTOS_TOKEN` | 写端点令牌闸（连接/发布/裁决/动作等要写库的 API 需 `Authorization: Bearer <token>`） | 不设 = 演示模式全放开 |
