# Ontos（安托斯）— 通用 Ontology 平台 MVP 设计文档

> 命名：Ontos 为 Ontology 的希腊词根（存在/本体）。Slogan：**让系统回归存在本身**。
> V1.4（2026-08-05）｜ 定位：老系统改造的本体中间件 —— 逆向建模 → 多源整合 → 生成新系统 → Agent 问数
> V1.1 变更：查询 Agent 从 V1.5 提前至 V1 演示链路，V1 形成"建模→整合→生成→问数"四步闭环（语义层 + 半个动力层）。
> V1.2 变更：明确数据边界——业务数据零落地，M7 问数走只读联邦查询实时查源库；交集验证补充"先归一化再比对"前提。
> V1.3 变更：M7 定为结构化查询+确定性编译，跨源内存拼装限复杂度；交集计算内存完成不落地；②/③区分补状态/时间证据；元模型补五概念、③示例与主键策略。
> V1.4 变更：元模型加 identity 匹配键；③示例 status 标注派生规则；M7 补跨源匹配语义。

## 1. 产品定位

**一句话**：从企业存量数据库（MySQL/PG）自动逆向出业务本体，把多个老系统的同义对象整合为统一模型，以本体为蓝图一键生成新系统骨架（库表 + CRUD API + 管理界面），并让 Agent 基于本体"读懂数据"——全程字段级血缘可溯。

**MVP 演示链路（30 分钟，四步闭环）**：连两个老库 → AI 生成本体草稿 → 人工确认并做跨源合并裁决 → 生成可运行的新系统 → **Agent 基于本体自然语言问数**（含血缘追溯演示）。

**需求结论**：①场景=存量系统逆向建模与整合；②第一用途=改造/重建系统，问数 Agent 作为演示收官与本体价值的直观证明；③数据源=关系库（暂不含 Oracle）；④产出=可运行应用骨架；⑤以整合为主，整体替换为后续坡道。

**与本体论完整定义的关系**：完整 Ontology = 语义层（对象/属性/关系）+ 动力层（Action/Function/Rules），让 Agent 能读懂数据、推理根因、决策执行。V1 交付**语义层全部 + 动力层的"读懂数据"**（查询 Agent）；Action 执行与根因推理留 V2，元模型已预留扩展位，V1 本体无需重构即可升级。

**竞品一句话**（2026-08 调研）：逆向建模（SqlDBM/DataWorks/Ontop 各有缺口）、MDM（只做记录层合并）、代码生成器（输入非业务本体）三条赛道均无"逆向本体→模型层整合留痕→带血缘应用生成"的完整闭环，窗口存在但有限。定位是"**整合前期的语义对齐层**"，护城河=裁决知识库+映射资产+血缘数据。

## 2. 核心方法论：建模准确性如何保障

**合并决策不是二元判断，而是五种关系类型裁决**（以招聘系统 vs HR 系统为例）：

| 类型 | 建模方式 | 案例 |
|---|---|---|
| ①完全等价 | 合并为单对象，多源映射 | 两系统的"部门" |
| ②部分重叠 | 上位对象（"人员"）+ 各自特有属性 | 候选人/员工共享基础信息 |
| ③生命周期阶段 | 统一对象+状态属性+转化关系 | 候选人→员工（最可能答案） |
| ④子类型 | Interface 继承（V2 实现） | 内部推荐候选人 ⊂ 候选人 |
| ⑤仅名字像 | 不合并 | 招聘"职位JD" vs HR"岗位编制" |

**三层证据链**：

| 层 | 证据 | 强度 | 要点 |
|---|---|---|---|
| 1. Schema 语义 | LLM 建议+理由 | 软 | 只建议，不定案 |
| 2. 数据交集率 | 标识字段（身份证/手机号）集合交集，只读采样 | 硬 | ≈0%→⑤；≈100%→①/②（按属性重合度细分）；中间值→②/③（按状态/时间字段细分） |
| 3. 人工裁决 | 业务测试问题集 | 定案 | "查所有已转正人员"答对才算通过 |

为什么算交集：五种关系类型本质是"两系统记录是否同一批现实实体"的五种答案，交集率是最直接的量化——命名会骗人，数据不会。交集**先归一化再比对**（去区号/分隔符、跳过脱敏字段），规则记入证据快照，否则硬证据本身会出错。分工：归一化规则库（手机号/身份证/邮箱等）按格式自动匹配优先，LLM 兜底建议（只看格式模式与脱敏样例）；归一化与交集计算全走确定性 SQL——模型当顾问，不当计算器。

**评估体系**：M2 用 3-5 个标注测试库跑回归（对象识别 P/R、属性映射准确率）；北星指标=**人工修改率**（草稿→确认稿编辑距离）+**裁决接受率**；可执行性验证（本体生成查询 vs 手写 SQL 结果比对）是唯一全自动客观验证。LLM 只产草稿、裁决权永远在人——底线不动摇（实测 LLM 建模准确率仅 68–86%）。

## 3. 系统架构与模块

```
源库A(MySQL) ─┐              ┌─ M4 本体管理（YAML+Git+React Flow）
源库B(PG)   ──┼→ M1 连接器 → M2 AI逆向建模 → M3 整合工作台 ─┐
              │   (内省+采样)   (草稿+确认)    (五类型裁决+交集验证) ↓
              │            M7 查询 Agent ←── M5 正向生成器 ──→ M6 血缘追溯
              │            (本体上下文问数)    （迁移+CRUD+Refine）
              └────────────────────────┘
```

| 模块 | 职责 | 关键点 |
|---|---|---|
| M1 连接器 | 连 MySQL/PG，内省 schema + 采样 | 只读；drizzle-kit pull 为主，数据字典兜底 |
| M2 AI 逆向建模 | schema → 本体草稿（YAML） | 只产草稿不落库；测试库回归评测集 |
| M3 整合工作台 | 五关系类型裁决、交集验证、留痕 | **差异化核心①** |
| M4 本体管理 | YAML + Git 版本化 + 可视化 | 本体=单一事实源 |
| M5 正向生成器 | 本体 → 迁移脚本 + CRUD API + Refine 界面 | **差异化核心②**：生成物带血缘标注 |
| M6 血缘追溯 | 字段级：新系统字段 → 本体属性 → 源表列 | M7 的取数路径说明=查询级血缘，复用同一映射 |
| M7 查询 Agent（含本体查询服务） | 自然语言 → 结构化查询（Zod 校验）→ 编译执行 → 答案+解释 | LLM 只产结构化查询，SQL 由查询服务确定性编译；query_logs 可回放 |

**两条 API 不要混淆**：M5 的 CRUD API 属于新系统，读写新库（空库起步，只承接增量）；M7 的本体查询服务只读，按 sources 映射实时查源库——**平台不迁移、不复制业务数据**。跨源查询各源分别下推、应用层内存拼装，限跳数限行数；查统一对象=各源 union，"转正"这类跨源条件按 identity 归一化匹配两源记录（与交集验证同一套机制）；大规模联合查询是 V2 物化的边界。

## 4. 最小元模型（5 个概念）

五个概念：对象类型、属性、关系、源映射、接口（V1 只留扩展位，V2 用于④子类型）。

```yaml
object_types:
  customer:
    label: 客户
    properties:
      - { name: id, type: int, pk: true }
      - { name: name, type: string, label: 姓名 }
    sources:                       # 多源映射（整合的关键结构）
      - { connection: old_erp, table: customers, pk: cust_id,
          fields: { name: cust_name } }
      - { connection: old_crm, table: t_client,  pk: client_no,
          fields: { name: client_name } }
link_types:
  - { name: placed, from: customer, to: order, via: { fk: orders.customer_id } }
```

五种关系类型的表达：①=单对象多 sources；②=上位对象+属性上移；③=统一对象+状态属性+转化 link；④=Interface（V1 预留）；⑤=无映射。Action/Function V1 不实现，YAML 预留扩展位。查询 Agent 的上下文即由本 YAML 生成（对象清单+属性标签+关系路径）。

③生命周期阶段的完整示例（即 demo 案例：候选人 → 员工）：

```yaml
object_types:
  person:
    label: 人员
    identity: id_card                          # 匹配键：跨源"认人"的属性
    properties:
      - { name: id,      type: uuid, pk: true }                      # 新系统代理主键
      - { name: name,    type: string, label: 姓名 }
      - { name: id_card, type: string, label: 身份证 }
      - { name: status,  type: enum, values: [候选人, 在职, 离职], label: 状态 }
        # 派生属性：仅在招聘源→候选人；命中 HR 源→在职（HR 状态=离职→离职）
    sources:
      - { connection: recruiting, table: candidate, pk: cand_id,
          fields: { name: candidate_name, id_card: idcard_no } }
      - { connection: hr,         table: employee,  pk: emp_no,
          fields: { name: emp_name, id_card: id_card } }
link_types:
  - { name: converted, from: person, to: person,
      via: { transition: { status: [候选人, 在职] } } }              # 阶段转化关系
```

**新库主键策略**：统一 uuid 代理主键，源表主键映射留在 `object_mappings`，正向生成与血缘以此为锚。

**identity（匹配键）**：声明跨源"认人"的属性（身份证/手机号等），M3 裁决时选定并落进对象定义，交集验证与 M7 跨源匹配同用。`status` 这类派生属性无源字段可映射，按"记录出现在哪些源 + 源状态字段"推导，规则写在对象定义里。

## 5. 技术选型（TypeScript 全栈，已定稿）

| 层 | 选型 | 理由 |
|---|---|---|
| 前端 | Next.js + shadcn/ui；React Flow（本体图）；AG Grid + rjsf（裁决界面）；Refine（生成的管理界面） | 全部现成组件，自研只做血缘可视化 |
| 后端 | NestJS | 与前端同语言，模块结构适合出码 |
| 数据库连接 | Drizzle ORM（mysql2/pg） | 轻量现代；Oracle 留 V2 |
| LLM/Agent | Vercel AI SDK（generateObject + Zod + tool） | 三个 LLM 流程（建模草稿/合并建议/问数）无需编排框架；复杂后迁 Mastra |
| 出码 | Nunjucks 确定性模板 | 禁止 LLM 直接写代码 |
| 迁移/CRUD | drizzle-kit migrations；@dataui/crud | 开箱即用 |
| 存储 | PostgreSQL（本体 JSONB + 9 张核心表） | 只存平台元数据与日志，**不存业务数据**：connections / ontologies / ontology_versions / object_mappings / merge_decisions / overlap_analyses / api_keys / generation_logs / query_logs |

**留门**：信创客户→后端换 Java（Spring Boot 3 + Spring AI + Flyway），YAML 与前端不受影响；Oracle→V2 加 node-oracledb connector。

## 6. 四周计划与验收

| 周 | 交付 | 验收 |
|---|---|---|
| W1 | 工程骨架 + M1 连接器 + schema 浏览界面 | 连上两个 mock 库，页面看到表结构与采样 |
| W2 | M2 AI 建模 + M4 YAML 管理 | 10 表库生成本体草稿，人工改两处保存 |
| W3 | M3 整合工作台 + M6 血缘 | 招聘/HR 案例按③建模成功，交集证据可查 |
| W4 | M5 生成器 + M7 查询 Agent + 演示打磨 | 端到端 demo：新应用增删改查 + Agent 答对业务测试问题 |

**Demo 脚本**（mock 两个库：招聘系统 + HR 系统，人员表交叉但不同）：配置连接(2min) → AI 生草稿(4min) → 系统提示"候选人/员工交集率 34%，建议按生命周期建模"、人工裁决(8min) → 一键生成(即时) → 新系统增删改查 + 字段血缘展示 → **Agent 问数收官**："查所有从候选人转正的员工及其部门"，Agent 沿本体关系取数、给出答案与取数路径说明（≤30min 含讲解）。

## 7. 红线与风险

**V1 不做**：Action 写回与根因推理（V2，含 Rules 正式化）、数据迁移（golden record，V2 边界=与 MDM 的分界）、CDC 物化、模板市场/多租户/细粒度权限（V3）、图数据库、Oracle 连接。

**数据边界（不可协商）**：不迁移、不复制业务数据；问数与血缘验证均只读实时查源库。新系统空库起步、只承接增量，存量迁移是 V2 的事。两个易踩穿的点：交集在内存中计算，`overlap_analyses` 只存比率/规则/摘要，标识集合不落地；`query_logs` 不存答案结果集，只存行数摘要。

**三大风险**：①LLM 建模质量不稳 → 草稿+人工确认+评测集回归；②关系类型判错 → 证据快照+人工裁决+可回滚；③被快速复制 → 护城河在裁决知识库、本体质量与血缘数据，而非生成器本身。

**问数专项风险**：NL 查询答错 → Agent 只能走本体 API（禁自由 SQL），query_logs 全量记录可回放；业务测试问题集即问数验收基准，答错即本体或映射有误，回 M2/M3 修正。
