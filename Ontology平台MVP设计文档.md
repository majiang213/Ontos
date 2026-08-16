# Ontos（安托斯）— 通用 Ontology 平台 MVP 设计文档

> 命名：Ontos 为 Ontology 的希腊词根（存在/本体）。Slogan：**让系统回归存在本身**。
> V1.7（2026-08-13）｜ 定位：老系统上的本体中间件 —— 逆向建模 → 多源整合 → 原库上受控读写（问数 + 动作）
> V1.1 变更：查询 Agent 从 V1.5 提前至 V1 演示链路，V1 形成"建模→整合→生成→问数"四步闭环（语义层 + 半个动力层）。
> V1.2 变更：明确数据边界——业务数据零落地，M7 问数走只读联邦查询实时查源库；交集验证补充"先归一化再比对"前提。
> V1.3 变更：M7 定为结构化查询+确定性编译，跨源内存拼装限复杂度；交集计算内存完成不落地；②/③区分补状态/时间证据；元模型补五概念、③示例与主键策略。
> V1.4 变更：元模型加 identity 匹配键；③示例 status 标注派生规则；M7 补跨源匹配语义。
> V1.5 变更：附录 A，划清本体论内核与工程外壳。
> V1.6 变更：§8 写与 Agent 边界——不造新库、动作由平台执行器投影回原库；生成用人驱动再生成，不做 ReAct。
> V1.6.1 变更：§8.5 补完整 YAML 实例——元素说明、画布持久化内容、一次读/一次写的执行物。
> V1.7 变更：§1/3/5/6/7 与 §8 对齐——不造新库、不出码；产出改为已发布本体 + 问数/动作执行器；Nest/Refine/Nunjucks 撤出本期选型。
> V1.8 变更：§8.6 多样业务按本体论适配——同个体多源投影 / 关联对象诞生 / 另立动作；JSON 只选哪条已发布定义。
> V1.8.1 变更：§8.5 YAML/JSON 实例补全入职下发考勤·工资、工资账户诞生、绩效另立动作。

## 1. 产品定位

**一句话**：从企业存量库（MySQL/PG）逆向出业务本体，跨源整合成单一事实源；以本体为读写层盖在原库上——问数与动作都走平台执行器。不造新库，不改客户应用。

**MVP 演示链路（30 分钟）**：连两个老库 → AI 生草稿 → 人工裁决（人员按 ③）→ 发布本体 → **问数**（转正员工及部门）→ **录用一人写回 HR** → 再问，状态已变（含取数路径）。

**需求结论**：①场景=存量逆向建模与整合；②第一用途=在原系统上盖语义读写层，不是重建一套应用；③数据源=关系库（暂不含 Oracle）；④产出=已发布本体 + 问数/动作 API；⑤整合为主，客户业务代码不改，最多给可写账号。

**与本体论完整定义的关系**：完整 Ontology = 语义层 + 动力层（Action/Function/Rules）。本期交付语义层全部 + 动力层最小集（读懂数据 + 录用这类动作执行）。根因推理、Rules 正式化仍留以后。动作定义见 §8.5，不是「整块动力层留 V2」。

**竞品一句话**（2026-08 调研）：逆向建模、MDM（记录层合并）、代码生成器三条赛道均无「逆向本体 → 模型层整合留痕 → 原库上受控读写」的闭环。定位是原系统上的**语义对齐 + 受控读写层**。护城河=裁决知识库 + 映射资产 + 血缘；执行器可复制，不是护城河。

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
源库A(MySQL) ─┐              ┌─ M4 本体管理（YAML + 画布 + 版本）
源库B(PG)   ──┼→ M1 连接器 → M2 AI逆向建模 → M3 整合工作台
              │   (内省+采样)   (草稿，人改/再生成)  (五类型裁决+交集)
              │                         ↓ 发布
              │              已发布本体（单一事实源）
              │                    ├─ M7 查询服务（只读账号）
              │                    ├─ M8 动作执行器（可写账号）
              │                    └─ M6 取数路径 / 字段血缘
              └──── 业务行始终在原库；平台不存个体 ────┘
```

| 模块 | 职责 | 关键点 |
|---|---|---|
| M1 连接器 | 连 MySQL/PG，内省 schema + 采样 | 问数用只读账号；动作另备可写账号（或同一连接升权） |
| M2 AI 逆向建模 | schema → 本体草稿（YAML） | `generateObject` 一次产草稿；人改或再说一句再生成。无 ReAct |
| M3 整合工作台 | 五关系类型裁决、交集验证、留痕 | **差异化核心** |
| M4 本体管理 | YAML 版本化 + 画布 | 画布存的即 §8.5 A |
| M5 正向生成器 | ~~本体→新库+CRUD+Refine~~ | **本期不做** |
| M6 血缘 | 本体属性 → 源表列；问数=取数路径 | 没有「新系统字段」这一跳 |
| M7 查询服务 | NL→结构化查询→编译执行 | 确定性编译；不是对话 Agent |
| M8 动作执行器 | StructuredAction→校验→投影原库 | 与 M7 对等、同一进程；见 §8 |

**只有平台两条 API**：`POST /api/query` 只读原库；`POST /api/action` 投影写原库。没有「新系统 CRUD」。跨源读：各源下推、内存拼装，统一对象按 `identity` 匹配。写：按该动作 `project` 列表逐条投影（可多库）；跨库不做分布式事务，失败策略见 §8.6。大规模联合查询 / CDC 现不做。

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

五种关系类型的表达：①=单对象多 sources；②=上位对象+属性上移；③=统一对象+状态属性+转化 link；④=Interface（预留）；⑤=无映射。动作须写成 `pre`/`effect`/`project`（§8.5），不能只留白话。问数/动作的上下文都由本 YAML 来。完整实例以 §8.5 为准。

③生命周期阶段的完整示例（即 demo 案例：候选人 → 员工）：

```yaml
object_types:
  person:
    label: 人员
    identity: id_card                          # 匹配键：跨源"认人"的属性
    properties:
      - { name: id,      type: uuid, pk: true }                      # 本体侧代理键，不写回原库
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

**主键**：不建新库，无需「新库 uuid 策略」。源表主键留在 `sources.pk` 做投影锚。YAML 里的 `id: uuid` 只是本体侧可选代理键，不写回原库。

**identity（匹配键）**：声明跨源"认人"的属性，裁决时选定，交集验证、问数拼人、动作认人共用。`status` 派生规则写在对象上，读的时候算，禁止当普通字段写。

## 5. 技术选型（随 V1.7 修订）

本期不造新应用，选型从「出码全栈」收回「一个平台进程」。

| 层 | 选型 | 理由 / 相对旧稿 |
|---|---|---|
| 前端 | 现有 Next.js + React Flow + 画布面板 | 已够。不上 Refine（那是给生成出来的管理界面的） |
| 平台后端 | **先用 Next.js Route Handlers**（已有 `/api/query` 等） | 撤 NestJS：Nest 是为出码/模块拆分预备的，本期无出码。问数与动作同一进程 |
| 连原库 | Drizzle 或 mysql2/pg | 问数只读连接；动作可写连接。Oracle 仍以后 |
| LLM | Vercel AI SDK：`generateObject` + Zod | **不要 tool 循环、不要 Mastra**。三个槽：建模草稿、合并建议、NL→StructuredQuery / StructuredAction |
| 出码模板 | **本期不做** | Nunjucks / drizzle-kit migrations / @dataui/crud 从本期拿掉 |
| 对外调用 | HTTP；可选 MCP（`query` / `run_action` / `propose_*`） | Claude Code 等是调用方，循环不做进 Ontos |
| 存储 | 只存平台元数据 | connections / ontologies / ontology_versions / object_mappings / merge_decisions / overlap_analyses / query_logs / **action_logs**。**不存业务行**。Demo 可先内存 |

**留门**：信创→后端换 Java 时 YAML 与前端不受影响；真要出码再另议，不倒逼本期架构。

## 6. 四周计划与验收

| 周 | 交付 | 验收 |
|---|---|---|
| W1 | 工程骨架 + M1 连接器 + schema 浏览界面 | 连上两个 mock 库，页面看到表结构与采样 |
| W2 | M2 AI 建模 + M4 YAML 管理 | 10 表库生成本体草稿，人工改两处保存 |
| W3 | M3 整合工作台 + M6 血缘 | 招聘/HR 案例按③建模成功，交集证据可查 |
| W4 | M7 查询服务 + M8 动作执行器 + 演示打磨 | 问数答对业务测试题；录用一人后 HR 有行、再问状态已变 |

**Demo 脚本**（mock 招聘 + HR）：配置连接 → 生草稿 → 候选人/员工交集率 34%，按 ③ 裁决 → 发布本体 → 问「转正员工及部门」（取数路径）→ **录用一名候选人**（写 HR）→ 再问，此人已在职（≤30min 含讲解）。无「一键生成新系统」。

## 7. 红线与风险

**本期不做**：根因推理与 Rules 正式化、golden record / 存量迁移、CDC、出码与新应用骨架、模板市场/多租户、图数据库、Oracle。动作只做「投影回原库」这一条（录用），不做任意存储过程/审批流封装。

**数据边界（不可协商）**：不迁移、不复制业务数据；个体不进平台。问数只读实时查源库；写只按动作 `project` 打原库，平台留 `action_log` 摘要不留行。交集内存算，标识集合不落地；`query_logs` / `action_logs` 不存结果集。

**三大风险**：①LLM 建模质量不稳 → 草稿+人改+再生成+评测集；②关系类型判错 → 证据快照+裁决+可回滚；③被快速复制 → 护城河在裁决知识库与映射/血缘，不在执行器、更不在生成器。

**问数专项风险**：NL 查询答错 → Agent 只能走本体 API（禁自由 SQL），query_logs 全量记录可回放；业务测试问题集即问数验收基准，答错即本体或映射有误，回 M2/M3 修正。

## 8. 写与 Agent 边界（V1.6）

不造新库、不给每个源系统定制执行器。读仍联邦原库；写是对本体世界的合法变更，再投影回原库。客户业务代码不用改，最多给 Ontos 一个可写账号。

### 8.1 写是什么

写不是 `UPDATE` 表。种类：诞生/消亡、改特征、改关系、改存在方式（阶段/类型）。「录用」是最后一种：同一 `person`（`identity`）从候选人转为在职，并多一条 `converted`。不能 PATCH 派生 `status`。

动作改对象；`sources` + 五关系决定怎么投影。禁止再写 `record: hr.employee`（那是跳过变更集直接绑表）。

- ① 等价：先定每个属性谁收写。  
- ② 重叠：公共属性写下位，特有只写自己。  
- ③ 阶段：在职 = 这人在 HR 里存在 → 投影常是 upsert `employee`，招聘表不动。  
- ⑤ 同名不同类：写一侧绝不碰另一侧。

`person.status` 是读的规则（映射原列，或 ③ 派生）。录用前置只看 `status === 候选人`，不另做「两库侦察」。HR 的 `employee.status` 与本体 `person.status` 不是同一个东西。

### 8.2 动作语言与一次录用

Agent / 按钮 / MCP 都只许发 Zod JSON，与结构化查询成对：

```json
{ "action": "hire", "object": "person", "identity": "1101011980..." }
```

本体里的定义必须机器可读（白话 `does` 只给人看）：

```yaml
actions:
  - name: hire
    pre: { status: 候选人 }
    effect: { transition: { from: 候选人, to: 在职 } }
    project:
      - { connection: hr, table: employee, mode: upsert, by: identity, fields: [name, id_card] }
```

对照：`JSON.object` + `JSON.action` 去已发布本体里 **find 那一条**，不用 `if (action==="hire")`。校验用这条的 `pre`/`axioms`，改数用这条的 `project`（列值从刚读到的个体 + `sources` 映射取）。

YAML 谁写：建模时模型写入草稿（③ 就建议 `hire`），人改、发布进 vN。执行时不再写 YAML，对话只编 JSON。

跑法：校验 → 读此人 `status` → `pre` 不通过则拒 → 按 `project` 逐条投影 → `action_log` → 再读验收。缺参先补全。某条投影失败则记失败，已写出的库不自动回滚（跨库无分布式事务）。

### 8.3 代码写在哪、进新系统加什么

执行器是 **Ontos 产品代码，写一次**：认 `upsert` / `update` / `delete`。Demo 与问数对等——`actionService` + `POST /api/action`，同一进程。不进客户招聘/HR 进程，不为每个源系统再写一份执行器。

每进一个系统只加数据：连接、映射、动作定义。换的是 YAML 里的 `connection` / `table` / `fields`。

| 持久化 | 即用即弃 |
|---|---|
| 本体、动作定义、映射、每次 `action_log` | 这一次编出的 SQL |
| 业务行仍在原库 | 不在平台存个体副本 |

原系统里有人直接录用：Ontos 当时无感；下次联邦一读就能看见。要连动作日志也有，才需要回调或 CDC（现不做）。

### 8.4 生成要模型，执行不要；不是 ReAct

| | 做什么 | 要不要模型 |
|---|---|---|
| **生成** | 对象、关系、识别字段、五关系建议、动作定义 | 要。只产草稿，人裁决 |
| **执行** | 按已发布本体问数、录用 | 不要。执行器解释说明书 |

理解发生在生成期（`hire` 写进本体时）。执行期再让模型「理解着写库」= 发明表、写一半。准确性不靠循环：结构 schema 卡住、交集率挡合并、人改画布/裁决。LLM 建模本就 68–86%。

画布上「上一版 + 用户一句话 → 再生成」是**人驱动的再生成**，不是 ReAct：人说一句 → `generateObject` 一次 → 草稿上画布 → **停**。模型不自己选工具、不自己写库。ReAct 是模型在内部转圈直到它自己觉得完了。不要在后端做会转圈的 Agent。

入口可以两个，内核同一套：画布点「生成对象」→ 后端 `generateObject`；Claude Code / Claude 调 MCP（`propose_ontology` / `propose_action` / `query` / `run_action`）。不是把 Ontos「接入 Claude 里改它」。Skill 只是说明书，不能单独写库。问数/录用对外部 Agent 就是工具调用，Ontos 内无 ReAct。

### 8.5 完整实例：元素、画布存什么、读/写这次跑什么

以招聘+HR 按 ③ 裁决后为准，并已接入考勤、工资、绩效：考勤/工资人员表 = 同一人的源；工资账户 = 入职时诞生的关联对象；绩效周期 = 另一件事、另立动作。三样东西不要混：

| 东西 | 是什么 | 存哪 |
|---|---|---|
| 画布 / `ontology.yaml` | 世界上有什么（类、字段、关系、动作定义） | 持久化，随版本 |
| 一次读 | `StructuredQuery` JSON | 可存成问数 API；SQL 即弃 |
| 一次写 | `StructuredAction` JSON | `action_log`；SQL 即弃 |
| 业务行 | 张三那一行 | **只在原库**，YAML 里没有 |

#### 元素对照（YAML 键 = 本体论要素）

| YAML | 本体论 | 画布上 |
|---|---|---|
| `object_types` | 类 | 一个节点 |
| `properties` | 属性 | 节点里的字段 |
| `identity` | 识别标准 | 「识别字段」 |
| `kind` | 事物 / 事件 | 节点类型 |
| `parent` / `equivalent` | 子类型 / 类等价 | ④ 未做；① 多用多 `sources` |
| `derived` | 派生属性 | 字段旁的规则，不可直写 |
| `sources` | 概念→原表列 | 不单独成节点；表结构抽屉里看到去向 |
| `link_types` | 关系 | 节点之间的边 |
| `axioms` | 公理 | 约束，须结构化才能执行 |
| `functions` | 可计算谓词 | 展示用；问数也可写成 filter |
| `actions` | 动作（`pre`/`effect`/`project`） | 对象上的可发动操作 |
| `questions` | 验收题 | 不画在图上 |

连接账号（主机、密码）不进这份 YAML，在连接配置里。

#### A. 画布保存的（已发布 vN）

```yaml
# ontology.yaml —— 画布工作副本 / 发布快照。无业务行。
object_types:
  person:
    label: 人员
    kind: thing
    identity: id_card
    properties:
      - { name: id, type: uuid, pk: true }
      - { name: name, type: string, label: 姓名 }
      - { name: id_card, type: string, label: 身份证 }
      - name: status
        type: enum
        values: [候选人, 在职, 离职]
        label: 状态
        derived:
          - { sources: [recruiting], value: 候选人 }
          - { sources_includes: hr, from: { connection: hr, table: employee, column: status } }
      - { name: hired_at, type: date, label: 入职日期 }
    sources:
      - { connection: recruiting, table: candidate, pk: cand_id,
          fields: { name: candidate_name, id_card: idcard_no } }
      - { connection: hr, table: employee, pk: emp_no,
          fields: { name: emp_name, id_card: id_card, hired_at: hired_at } }
      # 同一人的源（身份证能认）——不是新对象
      - { connection: attendance, table: staff, pk: staff_id,
          fields: { name: name, id_card: id_no } }
      - { connection: payroll, table: employee, pk: emp_id,
          fields: { name: emp_name, id_card: id_card } }
    axioms:
      - { name: status_one, type: mutex, property: status }
    functions:
      - { name: is_converted, label: 是否已转正, rule: "status 从候选人变为在职" }
    actions:
      - name: hire
        label: 录用
        does: 候选人转为在职；此人出现在 HR/考勤/工资人员表，并开一个工资账户
        pre: { status: 候选人 }
        effect:
          transition: { from: 候选人, to: 在职 }
          link: converted
          create:
            - { object: payroll_account, link: has_account }
        project:
          # 同人多源
          - { connection: hr, table: employee, mode: upsert, by: identity, fields: [name, id_card] }
          - { connection: attendance, table: staff, mode: upsert, by: identity, fields: [name, id_card] }
          - { connection: payroll, table: employee, mode: upsert, by: identity, fields: [name, id_card] }
          # 关联对象
          - { connection: payroll, table: account, mode: upsert, by: identity, fields: [id_card],
              for: payroll_account }
      - name: open_review
        label: 开启绩效
        does: 为在职人员建本周期绩效档案——不是入职的同一变更
        pre: { status: 在职 }
        effect:
          create:
            - { object: performance_cycle, link: reviewed_in }
        project:
          - { connection: perf, table: review, mode: upsert, by: identity,
              fields: [id_card], extra: [cycle], for: performance_cycle }

  payroll_account:
    label: 工资账户
    kind: thing
    identity: id_card
    properties:
      - { name: id_card, type: string, label: 身份证 }
      - { name: opened_at, type: date, label: 开户日, derived: "随 hire 创建" }
    sources:
      - { connection: payroll, table: account, pk: acct_id,
          fields: { id_card: id_card } }

  performance_cycle:
    label: 绩效周期档案
    kind: event
    properties:
      - { name: id_card, type: string, label: 身份证 }
      - { name: cycle, type: string, label: 周期 }
    sources:
      - { connection: perf, table: review, pk: review_id,
          fields: { id_card: id_card, cycle: cycle } }

  department:
    label: 部门
    identity: name
    properties:
      - { name: code, type: string, pk: true, label: 部门编号 }
      - { name: name, type: string, label: 部门名 }
    sources:
      - { connection: recruiting, table: department, pk: dept_code, fields: { code: dept_code, name: dept_name } }
      - { connection: hr, table: department, pk: dept_id, fields: { code: dept_id, name: dept_name } }

  job_posting:
    label: 招聘职位
    properties:
      - { name: id, type: int, pk: true }
      - { name: title, type: string, label: 职位名 }
      - { name: jd_text, type: string, label: JD描述 }
    sources:
      - { connection: recruiting, table: job_posting, pk: job_id, fields: { id: job_id, title: title, jd_text: jd_text } }

  headcount_position:
    label: 岗位编制
    properties:
      - { name: id, type: int, pk: true }
      - { name: title, type: string, label: 岗位名 }
      - { name: headcount, type: int, label: 编制数 }
    sources:
      - { connection: hr, table: headcount_position, pk: pos_id, fields: { id: pos_id, title: title, headcount: headcount } }

link_types:
  - { name: converted, label: 转正, from: person, to: person, inverse: converted_from, card: "1:1",
      via: { transition: { status: [候选人, 在职] } } }
  - { name: works_in, label: 任职于, from: person, to: department, inverse: staffed_by, card: "n:1",
      via: { fk: "hr.employee.dept_id → hr.department.dept_id" } }
  - { name: applied_to, label: 应聘, from: person, to: job_posting,
      via: { column: "applied_position ↔ title" } }
  - { name: has_account, label: 拥有工资账户, from: person, to: payroll_account, card: "1:1",
      via: { identity: id_card } }
  - { name: reviewed_in, label: 参加绩效, from: person, to: performance_cycle, card: "1:n",
      via: { identity: id_card } }

questions:
  - 查所有从候选人转正的员工及其部门
  - 现在还有多少候选人
  - 张三的工资账户开了没有
```

画布节点 = `person` / `payroll_account` / `performance_cycle` / `department` / `job_posting` / `headcount_position`。表不当节点。

#### B. 读这次执行的（不写进 YAML）

「查所有从候选人转正的员工及其部门」：

```json
{ "object": "person", "filter": { "converted": true }, "expand": ["department"] }
```

「张三的工资账户开了没有」：

```json
{ "object": "person", "identity": "110101198001011234", "expand": ["payroll_account"] }
```

执行器拿 A 的 YAML + 这份 JSON：按 `sources` 下推、用 `id_card` 拼人、按 `derived` 算 `status`、沿 `link_types` expand。YAML 不变，原库不变。

#### C. 写这次执行的（只进 action_log）

**录用张三**（一次变更：阶段 + 同人三源 + 开账户）：

```json
{ "action": "hire", "object": "person", "identity": "110101198001011234" }
```

`find person.actions.hire` → `pre.status===候选人` → `effect` 变更集 → 按序投影（即用即弃）：

```sql
-- 同人：HR / 考勤 / 工资人员表
INSERT INTO hr.employee      (emp_name, id_card) VALUES ('张三', '110101198001011234') ON CONFLICT (id_card) DO UPDATE SET emp_name = EXCLUDED.emp_name;
INSERT INTO attendance.staff (name, id_no)       VALUES ('张三', '110101198001011234') ON CONFLICT (id_no)   DO UPDATE SET name = EXCLUDED.name;
INSERT INTO payroll.employee (emp_name, id_card) VALUES ('张三', '110101198001011234') ON CONFLICT (id_card) DO UPDATE SET emp_name = EXCLUDED.emp_name;
-- 关联对象：工资账户
INSERT INTO payroll.account  (id_card)           VALUES ('110101198001011234')         ON CONFLICT (id_card) DO NOTHING;
```

招聘库不动。不写 `status` 列。再读：`status=在职`，expand `payroll_account` 有行。

**开启绩效**（另一件事，另一次 JSON；入职当时不会自动跑）：

```json
{ "action": "open_review", "object": "person", "identity": "110101198001011234", "fields": { "cycle": "2026Q3" } }
```

`pre.status===在职` → 创建 `performance_cycle` →

```sql
INSERT INTO perf.review (id_card, cycle) VALUES ('110101198001011234', '2026Q3')
ON CONFLICT (id_card, cycle) DO NOTHING;
```

#### 8.6 多样业务：按本体论适配，不按行业写分支

入职后还要出现在考勤、绩效、工资——这不是「hire 的特殊逻辑」，是同一种存在论问题的三种落法。执行器仍然只认 `pre`/`effect`/`project`。

先问：那个系统里的东西，和 `person` 是什么关系？（还是五关系，不是工作流）

| 裁成 | 含义 | 写进本体 |
|---|---|---|
| 同一人的又一源（①/③） | 考勤/工资里就是这个人，身份证能认 | `person.sources` 加一行；`hire.project` 加一条 upsert。一次世界变更（变成在职），多处投影 |
| 关联对象诞生 | 工资账户、绩效档案不是「人」，是挂在人上的新个体 | 新 `object_types` + `link_types`；`hire.effect` 写「创建并连上」；`project` 投到对应表 |
| 另一件事 | 绩效下个月才建档，不是入职的同一变更 | **不要塞进 hire**。另立动作（如 `open_review`），另一次 JSON 调用 |

连上新库时走现有建模：模型建议「又一源 / 新对象 / 无关」，人裁决，改 YAML，发布。执行器一行 TypeScript 都不用为考勤重写。

JSON 始终只有「对谁、发动哪个已发布动作」。下发到几个系统，由那条动作当时的 `project`/`effect` 决定，不由模型在执行期临时发明。

跨库失败：不做两阶段提交。已成功的投影留下，失败条进 `action_log`；派生 `status` 仍按读规则算（只写下了 HR 就是在职，考勤没有行就是考勤源未命中）。补偿=再发一次同一动作（upsert 幂等）或人修。

本期验收仍可以只有 HR 一条 `project`。多源下发是同一套定义加行，不是新模块。

---

## 附录 A：本体论要素 × 本产品落地

本体论里有哪些东西，我们做成了哪些。连库、出码、画布壳不在此表。

| 本体论要素 | 一句话 | 现状 |
|---|---|---|
| 类（对象类型） | 领域里有哪些种东西 | **已落地**。画布节点 = 对象 |
| 属性 | 一类有哪些特征 | **已落地**。UI 叫字段 |
| 关系 | 类与类怎么连 | **已落地**。含逆关系、基数 |
| 识别标准 | 两实例何时是同一个 | **已落地**。`identity`，跨源认人与问数共用 |
| 个体（ABox） | 具体某个人、某条记录 | **不做**。数据留源库，平台不存个体 |
| 类等价 | 两个名字是同一个类 | **已落地**。① → 单对象挂多源；`equivalent` 字段有 |
| 上位 / 概括 | 两边部分重叠，抽公共类 | **已落地**。② → 上位对象 + 两侧特有属性 |
| 生命周期 / 阶段 | 同一实体的时间阶段 | **已落地**。③ → 派生 `status` + `converted` |
| 子类型（is-a） | 一类是另一类的特化 | **未做**。`parent` 字段有，④ 留 V2 |
| 同形异义 | 同名不是一类 | **已落地**。⑤ → 各自独立 |
| 事物 vs 事件 | 持续物 / 发生的事 | **字段有**。`kind`，未约束建模 |
| 派生属性 | 无源列、由规则推出 | **已落地**。`status` 由「出现在哪些源」推出 |
| 部分—整体 | A 是 B 的部分 | **未做** |
| 公理 | 必须遵守的约束 | **能写不跑**。YAML 白话字符串，无推理机 |
| 可计算谓词 | 「是否已转正」这类 | **能写不跑**。问数里 `converted` 写死双源命中 |
| 动作 | 对世界做什么（录用） | **已设计未落地**。见 §8；不绑表，改对象再投影原库 |
| 规则 / 推理 | 从已知推出新知 | **未做**。无 OWL、无包含检测、无一致性检查 |
| 形式语言 | OWL / RDF / 描述逻辑 | **未做**。用 YAML |
