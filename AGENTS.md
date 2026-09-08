# AGENTS.md — Ontos（安托斯）

> **2026-09-01 本体认识纠错注记**：判定归 Agent（五选一面板退场）、结论留痕迁工作记录（`adj_decision`）、生成改概念归纳、链带领域谓词、记录表与主体表分流。落点清单见 `.scratch/palantir-alignment/ontology-error-inventory.md`。本文件各节已按目标状态改写；对应代码迁移见其任务拆解。

通用 Ontology 平台（Next.js 前后端一体，仓库根目录即应用）：现有数据库 → 逆向本体 → 多源整合 → 原库上问数/动作。不造新库、本期不出码。产品与技术定义见《Ontology平台MVP设计文档.md》。

## 语言规则（先读这个再动文案）

1. **用户界面和 Agent 对话一律大白话。** 按钮、步骤名、提示、芯片——用户扫一眼就懂，不许查词典。
2. **术语分三档，用词前先看档位：**
   - ✅ **公认**：行业通用词，可直接用（如 主键、采样、版本）。
   - 🔶 **领域**：本体工程/数据治理圈内有定义，但 demo 受众未必听过——UI 里出现必须带白话注解。
   - 🔴 **自造**：本项目发明的词——UI 里尽量不用；必须用（产品核心概念）时，第一次出现配一句白话。
3. **代码内部不受白话限制**：标识符、注释、API 路由名可用工程术语（`introspect`、`lineage`、`normalize`）。白话约束只针对用户看得见的字。
4. **新造词先登记本表，再进 UI。** 表里"UI 说法"列就是标准答案，不要现场另造。
5. 反面教材：「保存并内省」曾直接上按钮——"内省"是数据库工程术语，用户没听过，已改为「保存并读取表结构」。

## 写文档和答问

根子不是某几个词写错，是**把一个词安在它安不上的主语上**，再图省事收成半句话。换场景同样会犯，禁词表挡不住。

下笔前先问三句。答不上就不要写那句。

1. **这个谓语能说谁？论元齐了没有？**  
   「判定」必须写清：谁判定、判定的是什么、该项是什么。应写「第三步判定这两个类之间的关系为生命周期」。  
   「判定结果为生命周期」缺了谁、缺了判定什么，仍是病句。换「选出」「该项为」而不补论元，还是同一错。  
   通式：先写出「A 对 B 做了什么」。A、B 对不上这个动词，整句重写。

2. **这句话在哪一层？**  
   存在 / 判定 / 配置 / 界面。一层一句。  
   「选出」「裁成」「认定」不要用在概念文里。  
   「一对」写成「被比对的两个类」。

3. **这两项是不是同类？**  
   能共用一个上位类别才能用顿号或「和」并列。句子成分、本体论关系、YAML 字段不是同类。不能并列就拆句。

4. **不要用左/右来描述。**  
   禁止：左端、右端、左侧、右侧、左边、右边（以及「键是左、值是右」）。比较、对照、`fields` 映射，都直接写是什么：刚读到的部门、请求里的部门、属性 `mark`、表上的列 `status`。  
   `mark: status` 写成「属性 mark 对照列 status」，不要写成「左边是属性、右边是列」。  
   界面方位（侧栏在窗口左边）不在此列。

还要守的范围，不是用词问题，是任务问题：

- 没让改文件就不要改。让改文档不要在聊天里讲课；让答问不要去改文件。用户说「分清」，是约束你的行为，不是让你删正文。
- 只动被点名的那一节。不改标题，不顺手删例子，不解释对方没问的概念。
- 概念文只写规定和软件结构，不写操作步骤。不进本体的中间结果，不要写成配置或画布。

检查：写完把主语圈出来，问「这个词能不能挂在这个主语上」。不能，就重写整句，不要只换一个字。文里若出现「左端 / 右端 / 左边 / 右边」在说比较或对照，整句重写。

## 文章里的 YAML 就是配置骨架

`ontos-article.md` 里的例子不是插图，是已发布本体配置的骨架，引擎按它执行。动一个键等于改系统核心。

下笔前再问三句。答不上就不要加那个键、那种形状。

1. **这个键是哪一层？** 存在（类、属性、关系、效应）/ 落点（源映射、写回）/ 告知。一层一个键。通知不是效应，列名不是属性。
2. **同类操作是不是同一套骨架？** `update` 和 `create` 都是「哪个类 → 找谁或新生谁 → 属性怎么赋值」。前置里的 `$link` 和效应里的 `filter.$link` 必须同形。两套写法就是没设计完。
3. **是不是为这一个场景新开的口？** 调岗、维修、验收只能当组合示例，不能各加专用键。加键前先问：没有这个场景，这个键还有没有独立含义。
4. **是不是保留字？** `$link`、`now`、`update`/`create`/`delete`/`link` 进了配置就是全系统保留字。新造一个必须先写入附录 B「保留字」表。完整已发布文本以附录 C 为准。认人必须写 `object` + `identity: { from: identity }` 或 `object` + `filter`，不许 `$root`，不许省略 `object` 当根。`match` 关系靠配对字段成立，`create` 不写 `link`。转化是 `- link: converted`，没有另一端。过滤落在哪一类，关系名就从哪一类出发。写回按效应和 `sources` 推出，动作上不要 `write` 名单。告知的 `properties` 必须写明来源。插入时要生业务编号：属性上 `generate` 是一段列表，按顺序拼接字面量、已有取值（`{ from: identity }`、请求字段）、`{ date: now/d, format: yyyyMMdd }`、`{ snowflake: true }`（64 位雪花号十进制串）、`{ uuid: v7 }`。效应写 `{ from: generated }`。不要「请求有就用、没有就编」。`appt_no` 只是任职编号的属性名，不是保留字。不要 `today`、`yesterday`、`builtin`、`addDays`，不要 `{ add: { left, right } }`，generate 里没有 `sequence`（发号器已整体改雪花，`{ sequence: { start, width } }` 是旧形状）。

改例子等于改附录 B。只改一处、另一处还用旧骨架，不许提交。

## 术语表

概念定义（是什么、判定依据、不是什么）的唯一出处是根目录 `CONTEXT.md`；本表不再复述定义，只留工程纪律与 UI 说法。改概念先改 CONTEXT，再对 ADR（`docs/adr/`）。

### 流程骨架（步骤名，UI 直用）

**连接数据源**：
配置只读账号接入源库，并读取其表结构（表/列/类型/主键/注释 + 3 行脱敏采样）。

**逆向建模** 🔶：
模型从勾选的表**归纳**出概念级对象（跨表归并同一概念、多源挂载、时期派生按需），直接上画布；表只是原料。整合由 Agent 按证据继续，人审画布。
_UI 说法_：逆向建模（步骤名保留）；动作用「生成对象」。

**多源整合** 🔴：
Agent 按证据对齐疑似同义的对象——该合并的合并、该连线的连线，全部落可回滚草稿（不同库，或同一库的两张表）；记录表与主体表的分流见「多源归并与关联链」。人在画布上审结果，不同意就在对话里指令推翻。
_UI 说法_：步骤名保留；纠正动作说「让 Agent 改」。

**发布本体**：
人审画布后亲手发布——草稿里的对象、链、动作定稿为单一事实源 `ontology.yaml`，版本化。发布永不经 Agent 之手。
_Avoid_：上线、提交、保存本体

**映射**：
已发布本体的字段去向、血缘。**不展示、不拉取业务行**——表结构抽屉同样只看列定义。真正取数只发生在外部 Agent 经 MCP 的 query 工具。
_UI 说法_：映射。_Avoid_：新系统、出码、运行中、对象列表查源库

### 本体结构

**本体 / Ontology** 🔶：
业务对象、属性、关系的机器可读定义（YAML），全平台的单一事实源：生成以它为蓝图，问数以它为上下文，血缘从它出发。
_UI 说法_：本体（产品核心词，保留）。

**工作空间** 🔴：
隔离单位：一个空间一套完整的本体配置、版本链、平台元数据、画布摆位。共享元库 + `workspace_id`（B 方案）：台账是 `onto_workspace` 注册表，版本链与**工作副本**同在 `onto_version`（`version IS NULL` 的一行是可变头，画布全部内容——本体+摆位+弯折+钉点——只活在它的 `canvas_json`；草稿修订号 `rev` 也持久化在这行，写走 CAS（`UPDATE … WHERE rev = ?`，0 行=冲突）；发布 = 工作行复制成编号行），其余各表都带 `workspace_id`；后端可换（默认单文件 SQLite `src/server/config/ontos-meta.db`，`ONTOS_META_DSN=mysql://…` 走 MySQL，`postgres://…` / `postgresql://…` 走 PostgreSQL）。**无状态**：草稿/已发布快照全部读库、无进程内写队列与内存缓存——同一份元库下任意多实例行为一致；多实例部署 = MySQL 或 PG 元库 + 每实例分配 `ONTOS_SNOWFLAKE_INSTANCE_ID`（0–1023，雪花号实例位；不分配则随机派生，碰撞概率极低但存在）。切换空间整套换掉，互不串。**default 与新建空间一样空白起步**（空本体、无连接，从连接数据源开始玩）；演示模板（`src/server/config/ontology.yaml`）与七个演示 fixture 连接只属于 `test`（测试工作空间，常驻空间列表，首次访问才注册，演示模板随注册发布成 v1——其余空间注册**不产生已发布版本**，首版由人发布）——按空间名判断填充，与是否配置 LLM Key 无关；fixture 各实例各自播种，多实例下对 `test` 空间的写会分叉（演示空间不承诺多实例一致）；API 用 `/api/<空间名>/…` 路径段指定。
_UI 说法_：工作空间（左上角下拉）。

**对象类型 / 属性 / 关系** 🔶：
定义见 CONTEXT「类 / 属性 / 关系」。
_UI 说法_：本体对象 / 字段（属性在 UI 里叫字段）/ 关系。_Avoid_：link type、property 直译混用

**源映射（sources）** 🔶：
定义见 CONTEXT「源映射」。
_UI 说法_：来源（如 `recruiting.candidate` 标签）。

**匹配键（identity）** 🔴：
工程纪律：交集验证与问数对齐共用这条属性（定义见 CONTEXT「同一性标准」）。
_UI 说法_：唯一键。_Avoid_：identity 直出、识别字段、认出同一对象靠的字段

**派生属性** 🔶：
无源字段可映射、按规则推导的属性（如 person.status 由"记录出现在哪些源"推出），规则写进对象定义。
_UI 说法_：派生字段（规则随字段展示）。

**时期中文名 / 时期标识** 🔴：
枚举值域项的两半：中文名（label）给人看，阶段块主显、点击轻改；标识（key）进配置与动作字面量，「改标识」级联改写值域、派生规则、转化关系与动作前置里的同名等值（带确认）。
_UI 说法_：中文名、改标识。

### 整合方法论（差异化核心）

**对齐判定** 🔴：
候选对的对齐定案，由 Agent 依证据（交集率、字段对应）执行，人在画布上审结果。定义见 CONTEXT「类与类」。不是类与类关系的穷尽（部分与整体、不相交本期不定案）。工程纪律：类等价、部分重叠、生命周期、同形异义在 demo 里可落本体；子类型 / 部分与整体 / 不相交本期不定案；跳过不是关系，配置不动；同一概念的表并入一个多源类（时期派生按需）；match 链（领域谓词）只在不同概念之间（ADR 0013）；结论与证据留痕住 `adj_decision`，不进本体配置；不同库和同一库的两张表都进召回。
_UI 说法_：判定是 Agent 的内部步骤，不设按钮（`VERDICT_LABELS`；decisions API 与 adj_decision 留痕存英文键 `same / overlap / stage / name_similar / skip`，汉字只当描述不当 Key）。_Avoid_: **对类关系计数的任何说法，一律不能用**——「五种结论」「二期三结论」「还剩几个」全在禁内：数几个都是在暗示这是一张封闭清单。类关系不是封闭清单：能落的逐个点名（类等价、部分重叠、生命周期、同形异义），未定案的逐个点名（子类型、部分与整体、不相交）；跳过是动作不是关系。文档与对话一视同仁。

**裁决** 🔴：
候选对的对齐定案：Agent 依证据执行并留痕，人在画布上审结果、以指令最终裁定去留——决定权在人的审与指令。留下谁、谁早谁晚、时期名由证据给出。裁决+证据快照全部留痕、可回滚。
_UI 说法_：裁决（产品核心词，保留）。

**候选对** 🔴：
定义见 CONTEXT「候选对」。工程纪律：模型提议按草稿内容快照落 `adj_candidates`——同一投喂形状（类名/连接集/字段名）只问一次模型，定案过滤在读时套，计数因此稳定，不当计算器的模型只补倾向与可执行方案（留下谁 / 谁早 / 时期名）。
_UI 说法_：疑似重复（Agent 建稿过程的召回结果，待定卡可见）；「候选对」只留在文档与代码。

**疑似重复串** 🔴：
定义见 CONTEXT「疑似重复串」。
_UI 说法_：不出现。召回一次一对的认识保留。_Avoid_: 簇、连通分量、独立题、一次裁整串

**交集率** 🔴：
定义与公式见 CONTEXT「交集率」。
_UI 说法_：交集率（配一句"两边同一批个体的比例"级注解）。

**归一化** ✅（数据领域）：
定义见 CONTEXT「交集率」（归一化后取值做集合重合）。工程纪律：去 +86/连字符/空格，跳过脱敏字段。
_UI 说法_：统一格式。_Avoid_：normalize 直出

**三层证据链** 🔴：
判定办法的三问与硬约束见 CONTEXT「判定办法」。工程纪律：两版建议是同一裁判——看过交集率后的第二版以清单快照里的第一版为锚；验收问题集不参与裁决。

**多源归并与关联链** 🟡：
同一概念的表**并成一个多源类**（来源覆盖面不同是数据事实，不是结构），时期语义用派生属性表达（ADR 0013）。**不同概念之间**的关联由 Agent 建**带领域谓词的 match 链**（模型按表间语义起名，如 `on_equipment`；起不出领域名的链不建）。历史草稿的 shared_ 公共对象仍按旧结论渲染。
_UI 说法_：避免"上位对象/公共对象"直出。

### 数据与边界

**数据边界** 🔴：
定义见 CONTEXT「数据边界」。工程纪律：交集内存算、标识集合不落地；采样脱敏。
_UI 说法_：只说人话承诺（"永不写源库""未落库"），不出现"数据边界"四字。

**联邦查询 / 只读联邦查询** 🔶：
不搬数据、按源映射实时下推各源、应用层内存拼装的查询方式。
_UI 说法_：实时查源库。_Avoid_：联邦查询直出

**血缘 / 字段血缘** 🔶（数据治理领域）：
字段级映射链：本体属性 → 源表列。查询级血缘 = 取数路径，复用同一映射。
_UI 说法_：血缘（tab 名保留）；问数场景叫「取数路径」。

**代理主键（uuid 策略）** ✅（数据库领域）：
新库统一 uuid 代理主键，源表主键留在映射里做锚。不进 UI。

### 问数与出码

**结构化查询（StructuredQuery）** 🔶：
LLM 问数的唯一产出物（Zod 校验），SQL 由查询服务确定性编译——模型当顾问不当计算器。
_UI 说法_：不出现缩写；展示时标题「结构化查询」即可。

**问数** 🔴：
自然语言查数据：编译出的结构化查询交查询服务确定性执行，随问随答，不留台账。平台自身不外置问数 UI——由外部 Agent 经 MCP 驱动（配套 skill 在 `skills/` 下四个目录：ontos-query / ontos-action-run / ontos-canvas / ontos-action）；站内仅验收问题集跑批用到这条编译链。
_UI 说法_：问数是能力词（问数示例）。

**取数路径** 🔴：
一次问数的执行步骤说明（查询级血缘），是答案可信度的来源。
_UI 说法_：取数路径。

**版本化 / 回滚** ✅：
每次发布把当时的本体写成 YAML，插入 `onto_version` 一行（首版为 v1）。点某个历史版本 = 用那一版覆盖当前工作副本（未发布），不新加版本；问数仍读已发布。要让问数也变成这版，再点发布。

### 明确不进 UI 的词

内省（→读取表结构）、出码（→生成）、正向生成器、动力层/语义层、Ontology-as-Code、落地（→落库/保存）、golden record、CDC、物化。
这些可以留在代码注释、设计文档和本文件里。

## 入口对照（同一动作在各层的名字）

同一个业务动作在 UI、路由、引擎、MCP 各层叫法不同，排查时按本表对，不要脑内翻译。UI 列是白话（用户看得见），其余列是工程词（代码符号）。

| 业务动作 | UI | HTTP 路由 | 引擎 | MCP 工具 |
|---|---|---|---|---|
| 生成对象 | 「生成对象」（先建议再导入） | `/api/propose_objects` 再 `/api/edit_draft`（`import_objects`） | `proposeObjects` 再 `import_objects` | `propose_objects` 再 `edit_draft`（`import_objects`） |
| 表结构 | 「数据源」抽屉右栏 | `/api/list_tables` | `resolveTableInfos` | `list_tables` |
| 选择演示库文件 | 数据源抽屉左栏一按接入（也可手动填路径） | `/api/list_sqlite_files` | `listSqliteFiles` | 无 |
| 疑似重复 | 待定卡（召回提出、还没判定的对，逐行一条带召回依据；有待定才出现） | `/api/list_candidates` | `listCandidates`（建议原语 `proposePairs`） | `list_candidates`（只看、不定案） |
| 识别唯一键 | Agent 在建稿中调用（数据试算 + 语义判别，结果落草稿） | `/api/propose_key` | `proposeKeyFor`（试算原语 `candidateKeyColumns` / `trial`，建议出口 `proposeKey`） | `propose_key`（开放给 Agent） |
| 交集率 | Agent 调用拿证据 | `/api/compute_overlap` | `computeOverlap`（底层算率 `overlapRate`） | `compute_overlap`（开放给 Agent） |
| 看过交集率再建议 | Agent 二轮定案 | `/api/propose_pair` | `proposePair` | `propose_pair`（开放给 Agent） |
| 裁决 | Agent 落结论（合并/建链/时期） | `/api/decide` | `decide` → `adjudicate`（走 mutateDraft 通道）→ `applyVerdict`（纯配置变换） | `decide`（开放给 Agent） |
| 发布 / 放弃 | 「发布 vN+1」「放弃」——**只有人点** | `/api/publish` | `publish` / `discard` | 无（发布永不经 Agent） |
| 画布编辑 | 对象卡、连线 | `/api/edit_draft` | `editDraft`，17 个 op（15 条改本体 + `save_layout` / `save_edge_bend`；钉点随建线/改接的 `pins` 同车；整理布局清弯折/钉点走 `save_layout` 的 `clear_bends` / `clear_pins` 旗标） | `edit_draft`（吃同一批内容 op，不含界面状态） |
| 问数 | 问题集「全量跑一遍」/「对草稿跑一遍」 | `/api/questions`（`?run=1`，可选 `&target=draft`）、`/api/query` | `nlToQuery` + `query` | `query`（入参已是结构化查询，Ontos 不编） |
| 动作执行 | 无（站外 Agent 驱动） | — | `runAction` | `run_action` |

五条纪律：
- 同名同义才许同名：路由、引擎、MCP 三层同一个名字指同一个行为；行为不同必须不同名。`propose_objects` 只建议、不落地；落地一律 `edit_draft` + `import_objects`。画布按钮把这两步连着发，不另开一键路由。
- 通道与载荷分开：`edit_draft` 是通道（路由、引擎、MCP 同名），17 个 op 是载荷（MCP 抽掉 2 条界面状态，剩 15 条）——op 名在页面内部调用和 MCP 入参里是同一个词。
- 页面不设判定交互（判定归 Agent），MCP 暴露建稿原语与证据工具——粒度分层是设计，不是遗漏。发布没有 MCP 工具是刻意的：发布是人对结果的最终确认。裁决、交集率、识别唯一键、看过交集率再建议已开放给 Agent；疑似重复清单只读开放（`list_candidates`）。
- 新加入口时词干从本表已有工程词里取，不另造。只建议不落地的工具一律 `propose_` 前缀（`propose_objects` / `propose_action` / `propose_pair`）。
- 形状规约 module 统一 `*Spec.ts` 后缀（`valueSpec` / `filterSpec` / `actionSpec`），收在 `src/server/schema/spec/`；纯结构 Zod（config / ops / request）留在 schema 根，不用此后缀；schema 也是**共享内核**——跨域词汇（对齐判定的 `schema/verdict`：机器键、展示文案、建议形状）住这里，领域与前端都能安全引用。规约表是「位置 → 该位置允许的取值形状」的单一事实源：执行、静态校验、表单白名单都消费它，不另写手写投影。

## 代码结构纪律（评审六轴）

每次 review（含 `/code-review` 的 Standards 轴）按这六条过。能机器化的条目必须有守门测试，不靠人扫——`src/tests/structureGuard.test.ts` 与 `purityBoundary.test.ts` 是现行守门，违规先红测试，不靠记忆。

1. **调用方向**。层级：`schema` 最底（只引 errors 纯叶子）→ `meta` / `infra`（不反向依赖 features）→ `features` 各领域包 → 路由 / 前端。读路径不依赖写路径：`features/ontology/views` 只消费纯函数（`refs` / `sameConfig` / `ops/replaceObject` 的纯判定）；读引擎（`features/query/`）经 `Env` / `SourceDriver` 接口，不摸写解释器。值侧无环；type-only 引用编译期擦除，不算越界。
2. **不变量落在哪**。一条不变量一个家，且家是文件不是注释：每步改动的「落定」在 `commit.ts`、引用扫描在 `refs.ts`、界面状态跟随在 `canvasState.ts`、op 分派在 `ops/index.ts`、厚不变量一文件一个（`editObject` / `renameObject` / `editStages` / `editProperty` / `editLink` / `importObjects` / `replaceObject`）。文件头注释第一行写它回答的问题，不写谁调它。
3. **打开文件能否读完一个问题**。切分轴是「编辑一份规定这条链上的问题」，不是按本体要素（类/关系/动作）分，也不是按 17 个 op 一人一个文件。浅 case（单点赋值级）留分派，厚不变量（跨键跟随级）独立成文件。一个概念要跨三个以上文件才能读完，就是切错了。
4. **命名谓宾搭配**。主语要真：`configStore` 那种「声称存 config 实际不是」的假主语不许再出现。谓语和宾语要对得上：被 apply 的是 op 不是 draft，所以通道叫 `editDraft` 不叫 applyDraft。动词短语不当模块名（`editProperty` 这种「做什么编辑」的动名允许，因为它说的是住着的知识；`mustType` 这种纯调用句不行）。读路径和写路径共用规则时，规则放纯函数层，不许读 import 写。
5. **纪律单一住所**。同一规则 / 同一知识只写一遍，其余 import。现行登记处：名字形状 `NAME_RE`（schema/ops）、空间名 `WORKSPACE_NAME_RE`（infra/workspace，多许中划线是另一种纪律）、对齐属性 `sourceKeyProp`、唯一键判据与召回特征 `IDENTITY_COL_RULE` / `KEY_HINT_NAME_RE` / `KEY_HINT_DESC_RE`（infra/llm/identityHint，判定与召回分层：判定不按名字猜，召回只进门、数据判定）、「空=至今」`treatsNullAsUntilNow` / `treatsExpectedNullAsUntilNow`（schema/config）、「空 group_by = 全体合计」`aggregateSchema`（schema/request，总数聚合；对错板对聚合按合计比对）、运算符块判定 `isOpObject`（spec/filterSpec）、聚合产出列名 `metricColumn`（features/query/assemble）、转化动作名 `conversionActionName`（features/ontology/skeletons）、公共对象名 `sharedObjectName` / `isSharedObjectName`（schema/config；features/ontology/sharedName 原地再出口；历史草稿渲染用，新裁决建链名走 `overlapLinkName`）、过滤条件白话 `conditionText` / `filterText` / `operandText`（features/ontology/filterText，阶段条件全文与动作前置摘要共用）、枚举值域取 key 与中文名 `enumValueKey` / `enumValueLabel`（schema/config）、转化动作判定 `conversionActionOf`（features/ontology/stages）、对齐判定执行计划 `executionPlan` 与成对点名 `onPair`（schema/verdict）、裁决留痕 `adj_decision`（元库；画布徽章/虚线投影读它，历史草稿的 class_conclusions 兼容渲染——E1 迁移后现行口径）、界面状态原语 `definedPinEnds`（features/ontology/canvasState）、insert-ignore 与方言 upsert `insertIgnoreSql` / `upsertSql`（meta/stores/base）、元库 DSN 方言 `metaDialectOf`（meta/datasource）、边界入口 Result 收尾 `toResult`（server/errors，各入口不再自写 try/catch 阶梯）、业务拒绝落日志 `logReject`（server/errors，REST 与 MCP 的收尾共用一处）、元库 PG 占位符 `toPgPlaceholders`（meta/datasource；源驱动下推另有 `renderPlaceholders`，不互相 import）、验收状态词表 `Q_STATUS`（features/acceptance/questionStatus）、**用户可见错误文案 `MSG`（server/errors，唯一出处）**、十二套演示系统的清单/注释/文件播种与 sidecar 读写 `DEMO_SYSTEMS` / `DEMO_COMMENTS` / `writeDemoFiles` / `readSidecarComments`（infra/demoSystems，叶子模块：裸 node 可跑）、生成撞名改名规则 `prefixedTableName` 与落地前硬闸 `disambiguateClassNames`（infra/llm/llm）、底中判定卡行首标签 `verdictLabel`（components/canvas/sharedOrigin，留痕/待定两卡共用，Tendency ⊂ Verdict 同一次查表）、四波对错板 `QUESTION_PACKS`（features/acceptance/questionPacks）、演示问数剧本与候选对剧本 `demoQueries` / `DEMO_PAIRS`（infra/llm/demo，test 空间无 Key 的确定性演示，正则顺序即优先级、剧本类名与模板隐式耦合——模板改名要同步这里）。新单源先登记本表再落地。
6. **代码坏味道**。报错文案不当机器判据（判定走结构参数，如 `exceptAction`）；吞错必须注释说清为什么安全；错误类型按域归一（EngineReject / DraftReject / ConnectionReject / WorkspaceReject），调用方不猜类型；内部形状（SQL / 主机 / 路径 / 堆栈）不进用户可见输出，生产只给「内部错误」（`_shared.internalErrorMessage` 单闸）；无调试残留（console.log / dbg）；无死导出。

**评审检查单（每轮 review 按此过，Spec 轴同样适用；源自 2026-09-02 六票评审的真实漏诊）**：

- **前端·卡面契约**：`float-card` 只定位不画背景——卡面必须由 `<Bezel>`（.bezel/.bezel-core）提供；每个 float-card 使用点核对 Bezel 配套，或组件有替代表面。新写浮动卡照 `DecideCard` 的外壳结构，不手抄。
- **前端·CSS 存活对应（双向）**：组件的 JSX 结构满足类名对应的 CSS 契约（如 `.decide` = 根容器 + Bezel + decide-head + decide-body 滚动区）；反向，CSS 里组件已不引用的选择器 = 死样式。删组件连坐专属样式段与专属测试。
- **前端·渲染边界**：列表容器要有滚动/裁剪约束（max-height + overflow），不能让内容溢出面板铺满画布；数据清空时卡片与入口的消失行为要有断言或实测（例：待定清零自动收卡）。
- **前端·渲染实测**：卡面、溢出、层级这类结构问题 tsc 与单测全绿也抓不住——评审通过后用浏览器实测工具复现过的场景（ego-browser / Chrome DevTools 均可）。
- **序列场景**：写操作之后的后续编辑是 bug 高发序列（反面案例：钉快照漏带 per-class 指纹，一次合并判定后收敛失效）——「不会回流 / 不会重复 / 记忆随写延续」类断言要显式测试钉住，单点测试绿不代表序列不炸。
- **票面核对（Spec 轴）**：不采信交付者自述——票面勾选 `[x]` 逐条对照代码独立核实；实现期的设计修正要回写票面，定案与实现不得自相矛盾；审查「守门落在文档/行为规范」类的勾选时，确认被挡住的行为真的有闸。

## 本体论要素 × 落地（附录对照，写代码按此表）

| 要素 | 现状 |
|---|---|
| 类 / 属性 / 关系 | **已落地** |
| 识别标准 `identity` | **已落地** |
| 同一概念 / 不同概念关联 / 时期 / 同形异义 | **已落地**（同一概念的表并成一个多源类，时期派生按需；不同概念之间建带领域谓词的 match 链（ADR 0013）；结论与证据留痕住 `adj_decision`，不进本体配置） |
| 派生属性（status） | **已落地** |
| 个体 ABox | **不做**（数据留源库） |
| 子类型 / `parent` | **未做**（V2） |
| 部分与整体 | **未做**（V2） |
| 不相交 | **未做**（V2） |
| 事物 vs 事件 `kind` | **已约束**（召回按 kind 分流：记录表与主体表不互比；记录表的承接是与主体建链。见「多源归并与关联链」与纠错清单 E5） |
| 公理 / 谓词 / 动作 | 动作 **已落地**（`features/action` 执行器，对外经 MCP `run_action`）；公理 mutex 写入时校验，其余类型能写不跑；谓词即布尔派生，**已落地**（不另设构造）。导入落草稿时每类自动补一条 `set_fields`（按 identity 认人、写字段，唯一键与派生属性不可写，无可写字段不生成；字段改名/删除、部分重叠上移时级联跟随）；转化动作由生命周期裁决自动立（`convert_to_<晚阶段>`）；业务动作经 `set_action` 由人/Agent 写 |
| 变更事件与告知 | 拼装 **已落地**（`features/action/notify`，随 `run_action` 结果返回，`delivered: false`）；外发 **未做** |
| 推理机 / OWL | **未做** |

## 写与 Agent（实现时按此，详见设计文档 §9）

- **不造新库。** 写 = 改本体世界，再投影回原库。客户应用不改代码，最多给可写账号。
- **执行器写在 Ontos 后端一份**（`features/action`，对外经 MCP 的 `run_action` 工具）。不为每个源系统定制执行器；进新系统只加连接/映射/动作定义。
- **动作语言** = Zod JSON：`{ action, object, identity }`。本体里 `pre` / `effect` 必须机器可读；写回按效应和 `sources` 推出，动作上不写表名。禁止 `record: hr.employee` 直接绑表。禁止 PATCH 派生 `status`。录用前置只看 `person.status === 候选人`。
- **生成要模型，执行不要。** 模型产草稿并按证据整合（合并、连线、定键），人审画布、以指令纠偏。执行器解释已发布本体，禁自由 SQL。缺参可先补全，补完仍交执行器。
- **不是 ReAct。** 画布纠错 = 人改字段或再勾表点「生成对象」（`proposeObjects` 一次）→ 停。不要后端自转圈、自己调工具写库。Claude / Codex 是 MCP 调用方，不是把循环做进 Ontos。
- **持久化**：本体、动作定义、映射、`log_action`。SQL 即用即弃。业务行留原库。
- **create 幂等**：无状态化后没有进程内串行队列，并发重发同一 create 靠「源表 identity 列唯一索引 + 插入失败重查兜底」——源表 identity 列必须是唯一索引（fixture 已补），重发命中记幂等 note，不重复落行。
- **完整 YAML 实例**见《ontos-article.md》附录 C。JSON 只选已发布动作；校验/改数在该条 `pre`/`effect`。YAML 建模时模型草、人发布。
- **多样业务**（入职还要下发考勤/工资）按设计文档 §9：同一人的源就在本类 `sources` 加一行；不是人就加对象+effect；不是同一变更就另立动作。禁止按行业在执行器里写分支。

## 交互架构约定（画布优先 v5，别再退化）

- **单一画布页**：「本体构建」是唯一页面；问数与动作不外置 UI——外部 Agent 经 MCP（`/api/<空间名>/mcp`，配套 skill 在 `skills/` 下四个目录：ontos-query / ontos-action-run / ontos-canvas / ontos-action）驱动，Claude / Codex 是 MCP 调用方，循环不做进 Ontos。

- **工作台 = 本体画布**：初始即空画布。画布内容永远是当前工作副本（已发布合并本体上的未发布改动；空空间是空画布），随时可拖、可点节点编辑。
- **画布只放本体对象，schema 永不当节点**：源表是只读原料，躺在「数据源」抽屉里（每列标出映射去向）；画布节点 = 本体对象。对象 ↔ 源列是**多对多**：一列可喂多个对象，一个对象可挂多张表（编辑卡可从任意已连接源拉列进对象）。同一概念的表并成一个多源类（画布一个节点、多来源）；不同概念之间的关联由 Agent 建带领域谓词的 match 链；历史草稿的 shared_ 公共对象仍按 `class_conclusions`（`kind: overlap`，`shared`）的虚线投影渲染，线上标「公共部分」。节点底部的判定结论芯片统一「结论 · 对方类名」格式（悬停高亮对方）：部分重叠 / 生命周期为实心（结构已变），同形异义为虚线（两类都留下），类等价不打芯片（对方已并入本类，来源芯片即它）；一行一次裁决，不合成一团。
- **多选 → 生成对象 → 直接上画布**：表结构抽屉勾选表后点「生成对象」——模型归纳出概念级对象立刻上画布并收起抽屉。**没有预览卡、没有确认草稿卡**。表永远是原料不上画布（节点只可能是本体对象）。生成后的整合（定键、对齐、建链）由 Agent 按证据继续，人审画布、随时指令。点节点可随时改字段。
- **发布后修改走发布流程**：画布是**工作副本**——发布后的编辑（改字段/拉列/连线/删节点/加表）只标「待发布」，点工具条「发布 vN+1」才升版本入历史；问数与动作始终读**已发布**的快照。
- **手动建模暂不设站内入口**：对象一律从源表勾选生成；「新建对象」按钮已撤（2026-08-31，演示链路用不上），手动建模排到二期/三期、需要时再做。`create_object` op 保留——外部 Agent 经 MCP `edit_draft` 仍可建对象。无源对象不挂 `sources`，与导入的对象同等进工作副本。
- **没有步骤条**：阶段由状态推导（连接→生成对象→Agent 整合→发布），Agent 的决定与证据在留痕卡可见、未判定的对在待定卡可见（有待定才出现）；**侧栏没有流程列表**——引导全部由交互承担（空画布提示、数据源抽屉、发布条、对象编辑卡）。发布后问数/动作读已发布快照，不出码。
- **编辑→发布**：发布后画布是工作副本，发布按钮**常驻工具条**、永可点——有改动时是「发布 vN+1 / 放弃」，没改动时点「发布」弹提示（不置灰）；放弃=回退到已发布快照；问数与动作始终读**已发布**版本。
- **步骤动作 = 画布浮动卡**：左上一条工具条只放任务按钮（留痕、待定、发布与版本、验收问题集；待定只在有待定时出现），数据源抽屉开关（左下）、对象编辑卡与关系详情（右侧）；Agent 整合过程的决定与证据在留痕卡（底中浮动卡，只读），未判定的对在待定卡（底中浮动卡，只读、逐行一条带召回依据）。连接数据源进**数据源抽屉**左栏（演示文件一按接入 / 手动填只读连接），右栏按选中源勾选表 → 生成对象（不取业务行）；表结构和映射都收在底部抽屉。
- **随时可加数据源**：数据源抽屉常驻；发布后也可加——新源的表经勾选上画布，只裁决新产生的候选对。
- **页内无对话列**：点击不发消息。外部 Agent 经 MCP 工作，循环不做进 Ontos。
- **操作指引写在对应卡片上**；锁定/拦截反馈用瞬时 toast。
- **AI 的活自动跑，不为 AI 设点击**；人的点击只留给选表与发布——判定、整合全由 Agent 完成，人审画布、下指令。

## Agent skills

### Issue tracker

Issue 台账为本地 markdown：`.scratch/<feature>/` 一个特性一个目录。详见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用五个默认标签：needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix。详见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文布局：根目录 `CONTEXT.md` 与 `docs/adr/`。详见 `docs/agents/domain.md`。
