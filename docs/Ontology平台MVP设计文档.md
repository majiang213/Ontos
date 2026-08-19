# Ontos（安托斯）— 通用 Ontology 平台 MVP 设计文档

> 命名：Ontos 为 Ontology 的希腊词根（存在/本体）。Slogan：**让系统回归存在本身**。
> V2.0（2026-08-17）｜ 定位：老系统上的本体中间件 —— 逆向建模 → 多源整合 → 原库上受控读写（问数 + 动作）
> V2.0 变更：按《ontos-article.md》重写。配置键、查询与写入请求、派生属性、转化关系、写回、告知，以该文附录 B/C 为准；本文不另维护一份模式定义。演示案例从招聘/HR 换成该文的设备域（采购 → 设备 → 资产）。V1.1–V1.8.1 的变更记录见 git 历史。
> V2.1 变更：数据库只接 MySQL 和 PG；补平台元数据库设计（§6）、M7/M8 的源库防护（§3、§8）、Agent 循环三分说（§9）。
> V2.2 变更：元数据库表名按类别加前缀（conn_ / ont_ / adj_ / log_），补字段与索引设计。
> V2.2.1 变更：元数据库设计落成 SQL DDL，附方言注记。
> V2.3 变更：前缀 ont_ 改 onto_；补字段——conn_source 加 options 与 updated_at，onto_version 加 note 与 revert_of，adj_decision 加 source_a / source_b，log_query 加 session_id 与 model，log_action 加 error 与 duration_ms。
> V2.3.1 变更：DDL 定为 MySQL 8 方言（AUTO_INCREMENT、MEDIUMTEXT、ENGINE/CHARSET 后缀、ON UPDATE CURRENT_TIMESTAMP），PG/SQLite 适配见方言注记。
> V2.4 变更：裁决分级——合并类永远人定案，仅名称相似类可升级为机器定案、人抽检，升级节奏由裁决接受率决定（§2、§3 M3）。

## 1. 产品定位

**一句话**：平台从企业存量库（MySQL/PG）逆向出业务本体，跨源整合成单一事实源；本体盖在原库上——查询由引擎按类型与关系下推到原库执行，写入请求只说存在上发生了什么，执行器再按已发布动作把变化投影回源表。不造新库，不改客户应用。

**MVP 演示链路（30 分钟）**：连采购、设备、资产三个老库 → AI 生成对象草稿 → 人裁决两对候选对：在途设备 × 在役设备（序列号交集率约三分之一）裁为**阶段**，设备 × 资产台账裁为**同一** → 发布本体 → **问数**「在役设备及其所属部门」（附取数路径）→ **验收一台在途设备**：设备源、资产源各插入一行，并立一张保修卡 → 再问，这台设备的阶段已是在役。

**需求结论**：①场景 = 存量逆向建模与整合；②第一用途 = 在原系统上盖语义读写层，不是重建一套应用；③数据源 = 只接 MySQL 和 PG，其它数据库本期不接；④产出 = 已发布本体 + 问数/动作两条 API；⑤整合为主，客户业务代码不改，最多给一个可写账号。

**与本体论完整定义的关系**：本体论的要素清单比本期交付的多。本期交付：类、属性、关系、同一性标准、派生属性（两种形状）、公理（写入时校验）、动作（前置 / 效应 / 写回）、转化关系。本期不交付：子类型定案、部分与整体、规则与推理、OWL。函数不单设立构造，逐个体的计算统一写成派生属性。变更事件与告知已设计，本期不交付。逐条对照见附录 A；概念展开见《ontos-article.md》第 2 节。

**竞品一句话**（2026-08 调研）：逆向建模、MDM（记录层合并）、代码生成器三条赛道，都没有「逆向本体 → 模型层整合留痕 → 原库上受控读写」的闭环。本产品的定位是原系统上的**语义对齐 + 受控读写层**。护城河 = 裁决知识库 + 映射资产 + 血缘；执行器可复制，不是护城河。

## 2. 核心方法论：合并准确性如何保障

**合并决策不是二元判断，而是五种结论的裁决。** 人判定两个类之间是什么关系，判定的依据是两类个体的重合程度：

| 结论 | 情形 | 写进本体 |
|---|---|---|
| 同一 | 两个名字指同一类 | 合并为一个对象类型，挂多个源 |
| 部分重叠 | 个体有交集，又各有一部分不属于对方 | 公共部分立上位对象，各自特有的留在原类 |
| 阶段 | 两条记录是同一实体的不同时期 | 只留一个对象类型；阶段是派生属性，读时按规则现算；转化关系由动作在写入时记录 |
| 仅名称相似 | 名字像而所指不同 | 各自独立，互不映射 |
| 子类型 | 一类完全含于另一类 | 声明子类型；本期不做，不定案 |

**三层证据链**：

| 层 | 证据 | 强度 | 要点 |
|---|---|---|---|
| 1. schema 语义 | 模型比对类型名、字段名、字段类型，给出倾向和依据 | 软 | 只建议，不定案；建议大约六到八成准 |
| 2. 数据交集率 | 两端识别字段归一化后算取值交集 | 硬 | 接近零 → 仅名称相似；接近全交 → 同一或部分重叠（按属性重合度再分）；介于中间 → 部分重叠或阶段（按状态、时间字段再分） |
| 3. 人工裁决 | 人对候选对定案，结论写进本体 | 定案 | 裁决留痕，发布可回滚 |

为什么算交集：五种结论是「两个系统的记录是不是同一批现实实体」的五种答案，交集率是最直接的量化证据——命名会骗人，数据不会。比对之前先归一化：用确定性规则把识别字段的取值洗成统一格式（去分隔符、统一大小写）。已脱敏的按脱敏值比；明文出不了库的，平台把指纹计算下推到源库里做，拿回指纹再比。归一化与交集计算都是确定性的，模型不参与计算——模型当顾问，不当计算器。平台对源库只读采样，在内存里算交集，取值集合算完即弃。

**评估体系**：M2 用 3–5 个标注测试库跑回归（对象识别 P/R、属性映射准确率）；北星指标 = **人工修改率**（草稿到发布稿的编辑距离）+ **裁决接受率**；可执行性验证（本体查询结果与手写 SQL 比对）是唯一全自动客观验证。回归与指标评测排在 demo 之后另行安排，不占 W1–W4。模型只产草稿，裁决权永远在人——这条底线不动摇。

**裁决按后果分级，「裁决权在人」的行使方式不同。** 合并类（同一、部分重叠、阶段）改写本体结构，判错比不合并更糟，这类永远由人定案。注意交集率 100% 也可能是假证据：两端的识别字段若都是自增 ID，值域天然重合，「证据硬」不等于「可以自动并」。保持现状类（仅名称相似、跳过）不改本体，定错了以后能翻回来，这类可以升级自动化。自动化的形态是预分拣，不是替人裁：机器把高置信的「各自独立」直接定案，人批量确认、事后抽检；合并类候选永远排进裁决队列等人定案。人从逐题作答变成保留否决权——库大、候选对多时，这是唯一扛得住的形态。

**自动化等级是挣来的，不是设计出来的。** 上线先全人工，用评估体系盯裁决接受率：「仅名称相似」类建议的接受率长期接近满分，这一类才毕业成机器定案加抽检；合并类无论接受率多高都不毕业——一次错并的代价与一百次对的好处不对称。

## 3. 系统架构与模块

```
源库A(MySQL) ─┐              ┌─ M4 本体管理（配置 + 画布 + 版本）
源库B(PG)   ──┼→ M1 连接器 → M2 AI逆向建模 → M3 整合工作台
              │  (读表结构+采样)  (草稿，人改/再生成)  (结论裁决+交集)
              │                          ↓ 发布
              │              已发布本体（单一事实源）
              │                    ├─ M7 查询服务（只读账号）
              │                    ├─ M8 动作执行器（可写账号）
              │                    └─ M6 取数路径 / 字段血缘
              └──── 业务行始终在原库；平台不存个体 ────┘
```

| 模块 | 职责 | 关键点 |
|---|---|---|
| M1 连接器 | 连 MySQL/PG，读取表结构 + 脱敏采样 | 问数用只读账号；动作另备可写账号（或同一连接升权） |
| M2 AI 逆向建模 | 表结构 → 本体草稿 | `generateObject` 一次产草稿；人改，或再说一句再生成。无 ReAct |
| M3 整合工作台 | 候选对、交集验证、结论裁决（子类型本期不定案；仅名称相似类可由机器定案、人抽检）、留痕 | **差异化核心** |
| M4 本体管理 | 配置版本化 + 画布 | 画布是工作副本；已发布后的改动攒成「待发布」，点发布才升版本；引擎只读已发布快照 |
| M5 正向生成器 | ~~本体 → 新库 + CRUD~~ | **本期不做** |
| M6 血缘 | 本体属性 → 源表列 | 问数场景叫取数路径 |
| M7 查询服务 | 查询 JSON → 按已发布配置求值 | 确定性求值：下推各源、内存对齐，求值不含模型；默认查询治理：强制超时、`limit` 上限、聚合下推 |
| M8 动作执行器 | 动作 JSON → 前置/公理校验 → 投影原库 | 与 M7 对等、同一进程；写回按效应和源映射推出；每条投影是源库上的短事务，更新带条件（要改的列仍等于读到的值），条件不成立则判该条投影失败、重读重发。这是执行层防护，不改请求与配置的口径 |

**对外只有两条 API**：`POST /api/query` 只读原库；`POST /api/action` 按已发布动作投影写原库。没有「新系统 CRUD」。跨源读：各源分别下推，引擎内按同一性标准指定的属性把不同源的行对齐成同一个体。跨库写：不做分布式事务，失败条目进留痕，补偿是重发同一动作或人工修库。大规模联合查询、CDC 本期不做。

## 4. 元模型骨架

配置的完整键定义以《ontos-article.md》附录 B 为准，这里只定骨架。配置文本由两棵树加一份出站清单组成：`object_types` 下每个键是一个类，`link_types` 下每个键是一条关系，`outlets` 下每个键是一个出站（告知的接收方，见下文「动作」）。有名字的条目在 YAML 里一律写成映射，键就是机器名；列表只用于四处：`when` 规则、效应操作、告知条目、`match` 的配对。各层都可写 `description`，给人和 Agent 读，引擎不读；下面的键清单从略。

- **类**：`kind`（thing 或 event）/ `identity` / `properties` / `sources` / `axioms` / `actions`。`identity` 是同一性标准：取值为该类的一个源列属性的名。跨源对齐、问数认人、动作认人三处共用这条标准；界面上它叫识别字段。某源没有这一列时，该源条目写 `key`。
- **属性**：`type` / `description` / `values` / `generate`，以及可选的 `derived`。有 `derived` 就是派生属性：不对应源列，读时现算，不得出现在任何源的 `fields` 里。派生只有两种形状，没有第三种专用键。`when` 规则列表谈源：按个体出现在哪些源、已映射属性取什么值定值，从上到下取第一条命中。一条过滤取布尔：当前个体满足这条过滤则为真，过滤可含 `$link`。
- **源映射**：`connection` / `table` / `pk` / `fields` / `key`。`fields` 把源列属性对到列名。`pk` 只定位行，不是同一性标准。
- **关系**：`from` / `to` / `inverse` / `card`，外加 `match` 或 `transition` 二选一。`match`：两端各出一个属性配成一对，值相等则关系成立；可多对并列。`transition`：同一个体的阶段转化，块内 `property` 是派生属性名，`from` / `to` 是两个阶段值；判定规则见《ontos-article.md》§6.4。
- **动作**：`pre` / `effect` / `inform`。前置与查询过滤是同一套写法，多两个键：`$request` 把请求参数拉进比较；`$exists` 声明请求点名的个体在各源现在有没有行。效应是列表，每项四种操作之一：`update` / `create` / `delete` / `link`。其中 `link` 只用于转化关系；`match` 关系靠 `create` / `update` 写上的配对字段自然成立，效应里不另写。`inform` 是告知：写回之后引擎把这次变更收成一条变更事件，发给出站；本期预留，引擎不执行，机制见《ontos-article.md》§6.5。
- **公理**：挂在类上，键是 `type` / `property`。引擎在效应定完之后、投影之前校验：若这次变化发生，存在上是否仍合法。本期 `type` 只有 `mutex` 一种：挡住会让同一属性在同一时刻取两个值的写入。
- **写回**：动作定义里不出现表名。插还是改，看读出个体时该源有没有行。写哪张表由两部分推出：效应改了哪些属性，`sources` 里哪些源映射了这些属性。属性名按该源条目的 `fields` 对照成源列名。

演示案例的切片（完整可发布配置见《ontos-article.md》附录 C）：

```yaml
object_types:
  equipment:
    description: 设备
    kind: thing
    identity: serial_no               # 同一性标准：出厂序列号
    properties:
      name:     { type: string, description: 名称 }
      serial_no: { type: string, description: 出厂序列号 }
      dept:     { type: string, description: 所属部门编号 }
      mark:     { type: enum, values: [scrapped], description: 台账标记 }   # 源列属性，映射设备表的 status 列
      status:
        type: enum
        values: [in_transit, in_service, scrapped]
        description: 阶段
        derived:                      # 派生：不进任何源的 fields
          - when:
              device:
                mark: scrapped        # 设备源有行，且 mark 为报废
            value: scrapped
          - when:
              purchase: true          # 采购源必须有行
              device: false           # 设备源必须无行
            value: in_transit
          - when:
              device: true            # 设备源必须有行
            value: in_service
    sources:
      purchase:
        connection: purchase_sys
        table: po_item
        pk: po_id
        fields:
          name: item_name
          serial_no: sn
      device:
        connection: device_sys
        table: device
        pk: dev_id
        fields:
          name: name
          serial_no: serial_no
          dept: dept_id
          mark: status                # 设备表的 status 列对到属性 mark
      asset:                          # 第二对裁为同一后并入的源
        connection: asset_sys
        table: asset
        pk: asset_id
        fields:
          name: asset_name
          serial_no: sn
    axioms:
      status_one:
        type: mutex
        property: status            # 同一时刻一个阶段；引擎在投影前校验
    actions:
      convert:
        description: 验收入库
        pre:
          status: in_transit          # 现在必须在途
          $link:
            converted: false          # 转化尚未发生
        effect:
          - link: converted           # 转化没有另一端，作用在请求点名的那台设备上
          - create:
              object: warranty_card   # 保修卡类见附录 C，切片从略
              properties:
                serial_no: { from: identity }
                expiry: now+1y        # 到期日=今天起一年
  department:
    description: 部门
    kind: thing
    identity: dept_id
    properties:
      name:    { type: string, description: 部门名称 }
      dept_id: { type: string, description: 部门编号 }
    sources:
      org:
        connection: device_sys
        table: department
        pk: dept_id
        fields:
          name: dept_name
          dept_id: dept_id
link_types:
  converted:
    description: 转化为
    from: equipment
    to: equipment                     # 同一台设备的两个阶段
    inverse: converted_from
    card: 1:1
    transition:
      property: status
      from: in_transit
      to: in_service
  belongs_to:
    description: 属于
    from: equipment
    to: department
    inverse: has_equipment
    card: N:1
    match:
      - { from: dept, to: dept_id }   # 两端属性值相等则关系成立
```

切片只示 `convert` 一条动作；调拨、报废、登记、结束维修与保修卡类见《ontos-article.md》附录 C。五种结论在配置里的表达：同一 = 一个类挂多个 `sources`；部分重叠 = 上位对象加属性上移；阶段 = 派生属性加 `transition` 关系加转化动作；仅名称相似 = 互不映射；子类型 = 本期不做。

## 5. 对外两个请求：查询与写入

请求的完整写法与求值规则见《ontos-article.md》第 5、6 节，这里各给一份演示案例上的实例。

**查询：`POST /api/query`。** 一次查询是一棵以类为根的树：

```json
{
  "object": "equipment",
  "properties": ["name"],
  "filter": { "status": "in_service" },
  "expand": [
    { "relation": "belongs_to", "properties": ["name"] }
  ]
}
```

这份请求的意思是：在役设备的名称，以及各自所属部门的名称。要点四条。`filter` 直挂的是属性条件（含派生属性）；关系条件收在 `$link` 下。类名、属性名、关系名对不上已发布配置，引擎拒绝，不猜。`expand` 按 `link_types` 里声明的关系进入目标类，反向写这条关系的 `inverse` 名；项内可以再套 `filter` 和 `expand`。根上写 `identity` 表示认准一个体，不再筛一批；写 `aggregate` 表示返回分组统计，不返回个体行。

**写入：`POST /api/action`。** 请求只点名，不描述怎么改：

```json
{ "action": "convert", "object": "equipment", "identity": "SN-40217" }
```

`action` 必须是该类 `actions` 里已发布的一条，不是引擎写死的枚举。带参数时第四个键是 `request`，例如调拨的目标部门。引擎按定义执行：读出个体，核对前置，按效应确定存在上的变化，校验公理，再按效应和 `sources` 逐条投影回源表，并记下留痕。投影语句即用即弃。跨库部分失败不回滚已成功的投影；补偿是重发同一动作：执行器重读个体，各源此刻有行就改、没行就插，已成功的源再投影一遍，结果不变；或者人工修库。

**Agent 编请求。** 类名、属性名、关系名、动作名全部读自已发布配置，不写死在 Agent 里。Agent 按需读三个视图，而不是整份配置：列出类；读取一个类（返回属性、关系、动作，不返回 `sources`、`pk`、`axioms`）；检索（类很多时按相关度返回类名、关系名）。问数答错时，由人回 M2/M3 修正本体或映射，不给 Agent 开自由 SQL。

## 6. 技术选型

本期不造新应用，选型从「出码全栈」收敛到「一个平台进程」。

| 层 | 选型 | 理由 |
|---|---|---|
| 前端 | 现有 Next.js + React Flow + 画布面板 | 已够。不上 Refine（那是给生成出来的管理界面的） |
| 平台后端 | Next.js Route Handlers（已有 `/api/query` 等） | 问数与动作同一进程；本期无出码，不上 NestJS |
| 连原库 | Drizzle 或 mysql2/pg | 问数只读连接；动作可写连接。只接 MySQL 和 PG，其它数据库以后再说 |
| LLM | Vercel AI SDK：`generateObject` + Zod | 三个槽：建模草稿、合并建议、自然语言 → 查询/动作 JSON。不要 tool 循环，不要 Mastra |
| 出码模板 | **本期不做** | Nunjucks / drizzle-kit migrations / @dataui/crud 从本期拿掉 |
| 对外调用 | HTTP；可选 MCP（`query` / `run_action` / `propose_*`） | Claude Code 等是调用方，循环不做进 Ontos |
| 存储 | 只存平台元数据 | 表结构见下文「平台元数据库」。**不存业务行** |

**留门**：信创要求后端换 Java 时，配置文本与前端不受影响；真要出码再另议，不倒逼本期架构。

### 平台元数据库

平台只存元数据。表结构按数据边界定：任何表没有业务数据列；交集只存计数与比率，标识值集合不落盘；日志存请求与成败，不存结果集；连接账号加密存，不进 ontology.yaml。验收问题集同样存平台库，不进 ontology.yaml。

表名按类别加前缀，新表先归类、再起名：

| 前缀 | 类别 | 表 |
|---|---|---|
| `conn_` | 接入 | conn_source |
| `onto_` | 本体 | onto_ontology、onto_version、onto_draft、onto_question |
| `adj_` | 裁决 | adj_decision、adj_overlap |
| `log_` | 留痕 | log_query、log_action |

```sql
-- 接入
CREATE TABLE conn_source (                     -- 数据源连接
  id         BIGINT PRIMARY KEY AUTO_INCREMENT,
  name       VARCHAR(128) NOT NULL UNIQUE,     -- 连接名，ontology.yaml 按它引用
  type       VARCHAR(8)   NOT NULL,            -- mysql | pg
  host       TEXT         NOT NULL,
  port       INT          NOT NULL,
  db_name    TEXT         NOT NULL,
  ro_user    VARCHAR(128) NOT NULL,            -- 只读账号
  ro_pass    TEXT         NOT NULL,            -- 密码加密存
  rw_user    VARCHAR(128),                     -- 可写账号，可空
  rw_pass    TEXT,                             -- 密码加密存
  options    JSON,                             -- ssl、超时等方言项
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 本体
CREATE TABLE onto_ontology (                   -- 本体；demo 一行
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  name        VARCHAR(128) NOT NULL UNIQUE,
  description TEXT,                            -- 这个本体覆盖哪个领域
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE onto_version (                    -- 版本快照
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  ontology_id BIGINT      NOT NULL REFERENCES onto_ontology(id),
  version     INT         NOT NULL,            -- 首版为 1
  yaml        MEDIUMTEXT  NOT NULL,            -- 全量快照
  origin      VARCHAR(8)  NOT NULL,            -- publish | rollback
  revert_of   INT,                             -- 回滚自哪个版本；origin=rollback 时有值
  note        TEXT,                            -- 发布说明
  created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ontology_id, version)                -- 取最新版按 version 倒序
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE onto_draft (                      -- 画布工作副本；每个本体一份
  ontology_id  BIGINT PRIMARY KEY REFERENCES onto_ontology(id),
  draft_yaml   MEDIUMTEXT NOT NULL,            -- 草稿文本
  layout       JSON,                           -- 节点坐标
  base_version INT       NOT NULL,             -- 基于哪个已发布版本
  dirty        BOOLEAN   NOT NULL DEFAULT FALSE, -- 是否有待发布改动
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE onto_question (                   -- 验收问题集
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  ontology_id BIGINT NOT NULL REFERENCES onto_ontology(id),
  version     INT    NOT NULL,
  question    TEXT   NOT NULL,
  expected    JSON,
  status      VARCHAR(8) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_question_version ON onto_question (ontology_id, version);

-- 裁决
CREATE TABLE adj_decision (                    -- 裁决留痕
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  ontology_id BIGINT NOT NULL REFERENCES onto_ontology(id),
  version     INT,                             -- 结论生效的已发布版本，发布时回填
  class_a     VARCHAR(128) NOT NULL,           -- 候选对的两个类
  class_b     VARCHAR(128) NOT NULL,
  source_a    VARCHAR(128) NOT NULL,           -- 两个类各自来自的源条目
  source_b    VARCHAR(128) NOT NULL,
  llm_advice  TEXT,                            -- 模型建议与依据
  rate        DECIMAL(5,4),                    -- 裁决时看到的交集率
  evidence    JSON,                            -- 证据快照：归一化规则、样本量、交集数
  verdict     VARCHAR(16)  NOT NULL,           -- 同一 | 部分重叠 | 阶段 | 仅名称相似 | 跳过
  decided_by  VARCHAR(128) NOT NULL,           -- 裁决人
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_decision_version ON adj_decision (ontology_id, version);
CREATE INDEX idx_decision_pair    ON adj_decision (ontology_id, class_a, class_b);

CREATE TABLE adj_overlap (                     -- 交集计算记录
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  ontology_id BIGINT NOT NULL REFERENCES onto_ontology(id),
  class_a     VARCHAR(128) NOT NULL,
  class_b     VARCHAR(128) NOT NULL,
  norm_rule   TEXT,                            -- 归一化规则
  count_a     INT NOT NULL,                    -- 两端数量与交集数
  count_b     INT NOT NULL,
  count_hit   INT NOT NULL,
  rate        DECIMAL(5,4) NOT NULL,
  computed_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_overlap_pair ON adj_overlap (ontology_id, class_a, class_b);

-- 留痕
CREATE TABLE log_query (                       -- 问数留痕
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  ontology_id BIGINT NOT NULL REFERENCES onto_ontology(id),
  version     INT    NOT NULL,                 -- 配置版本
  session_id  VARCHAR(64),                     -- 关联的会话
  model       VARCHAR(64),                     -- 编查询用的模型
  question    TEXT   NOT NULL,                 -- 自然语言
  query_json  JSON   NOT NULL,                 -- 编出的查询
  row_count   INT,                             -- 当时返回的行数；不是结果集
  error       TEXT,                            -- 失败原因摘要
  duration_ms INT,
  ok          BOOLEAN  NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_query_time ON log_query (ontology_id, created_at);

CREATE TABLE log_action (                      -- 动作留痕
  id           BIGINT PRIMARY KEY AUTO_INCREMENT,
  ontology_id  BIGINT NOT NULL REFERENCES onto_ontology(id),
  version      INT    NOT NULL,
  action       VARCHAR(128) NOT NULL,          -- 动作名
  object_type  VARCHAR(128) NOT NULL,          -- 类名
  subject      VARCHAR(128) NOT NULL,          -- 识别值
  request_json JSON,                           -- 请求参数
  projections  JSON,                           -- 各条投影的成败；演示期不拆子表
  error        TEXT,                           -- 前置/公理拒绝的原因；拒绝发生在投影之前
  duration_ms  INT,
  ok           BOOLEAN NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_action_time    ON log_action (ontology_id, created_at);
CREATE INDEX idx_action_subject ON log_action (ontology_id, object_type, subject);
```

方言注记：DDL 按 MySQL 8 方言写。换 PG 时：自增主键改 `GENERATED ALWAYS AS IDENTITY`，`MEDIUMTEXT` 改 `TEXT`，`JSON` 可换 `JSONB`，去掉 `ENGINE` / `CHARSET` 后缀；`ON UPDATE CURRENT_TIMESTAMP` 在 PG 里没有，`updated_at` 由应用层写。换 SQLite 时：自增主键改 `INTEGER PRIMARY KEY`，`JSON`、`BOOLEAN` 按 TEXT、INTEGER 存。

索引只建服务于已知查询路径的：按连接名找连接、按版本取快照、按候选对查历史、日志按时间回放、动作按个体追查。小表只有唯一约束。

三个取舍。版本存全量快照，不存增量 diff：本体文本不大，全量快照让回滚和版本比较都简单。裁决与交集分两张表：交集是机器算的，可重算；裁决是人定的，不可重算——两者生命周期不同。裁决留痕里的证据快照是对交集记录的有意冗余：交集重算后数字可能变，快照留住裁决时点看到的证据。`onto_ontology` 只存锚字段：本体的内容在追加式的版本快照里，「当前已发布版」永远等于 `MAX(version)`，不缓存 `current_version` 指针——它带不来信息，只会带来不一致的可能。demo 阶段可以先内存或 SQLite，表结构不变。

### 工作空间（空间隔离的结构）

**概念。** 工作空间是隔离单位：一个空间一套完整的「本体配置 + 版本链 + 平台元数据 + 画布摆位 + 对话历史」。空间之间不共享任何运行时状态；切换空间等于整套换掉。典型用法：一个空间演示设备域、另一个空间演 HR 域，或一个空间做正式、一个空间做试验。

**结构：共享元库 + `workspace_id`，一张注册表。** 隔离边界不再落在文件系统上，而是落在共享平台元数据库的 `workspace_id` 列上——这是接入外部 MySQL/PG 时的形态：一个实例管全部空间，跨空间统一管理成为合法需求。共享库的存在也让注册表有了宿主（文件制下「注册表没地方放」的自指问题在共享库下不成立）：

```sql
CREATE TABLE onto_workspace (                  -- 工作空间注册表
  id         BIGINT PRIMARY KEY AUTO_INCREMENT,
  name       VARCHAR(128) NOT NULL UNIQUE,     -- 空间名（小写字母/数字/中划线/下划线）
  seed_from  VARCHAR(128),                     -- 起步来源：模板名或 clone 来源空间
  layout     JSON,                             -- 画布摆位（对象名 → {x, y}）
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- **本体配置与版本链入库**：`onto_version` 增加 `workspace_id`，YAML 全量快照按 `(workspace_id, version)` 唯一；已发布版 = 该空间 `MAX(version)`，回滚照旧是 revert 语义（旧内容作为新版本插入）。摆位挂在 `onto_workspace.layout`。
- **其余 9 张元数据表**（conn_source、adj_decision、adj_overlap、ont_question、ont_query_api、log_query、log_action、meta_seq）全部增加 `workspace_id`，唯一约束与索引以 `(workspace_id, …)` 为首列；`meta_seq` 主键改 `(workspace_id, name)`。隔离从「物理分开」变为「列上纪律」：每条查询必须带 `WHERE workspace_id = ?`，这层纪律收在 MetaStore 一处，不漏给调用方。
- **后端可换**：共享元库是一个接口（`MetaBackend`）。离线开发默认单文件后端（即开即用，不改隔离语义——隔离在列上，不在文件上）；设 `ONTOS_META_DSN=mysql://…` 即换 MySQL，DDL 即本章 MySQL 8 方言。PG 同理（方言注记见上节）。
- **配置模板仍是文件**：`lib/config/ontology.yaml` 只当种子模板——新建空间把它插成该空间的 `onto_version` v1 行，此后不再被读。

**语义。** 默认空间 `default`，首次访问时若注册表里没有，自动建行并把种子模板插成 v1。新建空间同一条路（`ensureWorkspace`），从模板起步、干净画布。所有 API 接受 `?ws=<空间名>`，缺省即 `default`；已发布快照、工作副本、驱动注册表按空间名键控（内存态），元数据按 `workspace_id` 过滤（持久态），两层互不串。对话历史存在浏览器 localStorage，按 `ontos-chat-sessions:<空间名>` 分键。

**迁移。** 文件制（`workspaces/<name>/` 目录 + 每空间 SQLite 文件）被本方案取代；迁移是把每个空间的最新 YAML 与版本链插入共享库对应 `workspace_id` 的行，元数据各行补写 `workspace_id`。

## 7. 四周计划与验收

| 周 | 交付 | 验收 |
|---|---|---|
| W1 | 工程骨架（含元数据库建表；演示期可用内存或 SQLite 实现）+ M1 连接器 + 表结构浏览界面 | 连上 mock 库，页面看到表结构与采样 |
| W2 | M2 AI 建模 + M4 版本化与画布 | 另备的 10 表测试库（与演示三库分开，回归评测将此库纳入标注集）生成本体草稿，人工改两处保存 |
| W3 | M3 整合工作台 + M6 血缘 + 验收问题集初稿 | 在途/在役案例按阶段裁决成功，交集证据可查 |
| W4 | M7 查询服务 + M8 动作执行器 + 演示打磨 | 问数答对验收问题集；验收一台在途设备后，设备源、资产源各有新行，保修卡已立，再问阶段已在役 |

**Demo 脚本**（mock 采购 + 设备 + 资产三个库）：配置连接 → 生成对象（设备库同时带出部门对象和「属于」关系）→ 两对候选对分别裁为阶段、同一 → 发布本体 → 问「在役设备及其所属部门」（展示取数路径）→ 验收一台在途设备（设备源、资产源各插入一行，立一张保修卡）→ 再问，这台设备已在役。全程 ≤30 分钟含讲解，没有「一键生成新系统」。

## 8. 红线与风险

**本期不做**：规则与推理、OWL、子类型定案、部分与整体、golden record 与存量迁移、CDC、出码与新应用骨架、模板市场与多租户、图数据库、MySQL 和 PG 以外的数据库。函数不单设立构造。变更事件与告知已设计，本期不交付。动作只执行已发布定义，不封装任意存储过程与审批流。

**数据边界（不可协商）**：不迁移、不复制业务数据，个体不进平台。问数只读实时查源库；写只按已发布动作的效应与源映射投影原库，平台留 `log_action` 摘要，不留业务行。交集在内存里算，识别字段的取值集合不落地；`log_query` 与 `log_action` 不存结果集。

**风险**：①模型建模质量不稳 → 草稿 + 人改 + 再生成 + 评测集；②结论判错 → 证据快照 + 裁决留痕 + 发布可回滚，合并判错类型比不合并更糟，所以定案权在人；③被快速复制 → 护城河在裁决知识库与映射/血缘，不在执行器，更不在生成器；④客户真实库不给可写账号 → 动作链路失去前提，写回段改在 mock 库上演示，问数不受影响；⑤源库的负载与并发写传导进平台 → 问数与采样走只读账号并限额，可接只读副本；查询强制超时与限量；投影更新带条件，条件不成立则判该条投影失败、重读重发。

**问数专项风险**：自然语言查询答错 → Agent 只能走本体 API（禁自由 SQL），`log_query` 全量记录可回放。验收问题集有两个用途：裁决之后核对本体（《ontos-article.md》§3.2），以及作为问数验收基准。它随本体版本一并保存；问数答错即说明本体或映射有误，由人回 M2/M3 修正。

## 9. 写与 Agent 边界

**不造新库。** 写是对本体世界的合法变更，再投影回原库。执行器写在 Ontos 后端一份，与查询服务对等，不为每个源系统定制执行器。

**进新系统只加数据**：连接、映射、动作定义。先回答「那个系统里的对象和已有的类是什么关系」。答案有三种，各对应一步配置。是同一个体的又一源——在本类 `sources` 加一行；是挂在个体上的新对象——立一个新类、加一条关系到本类，效应用 `create`；是另一件事——本类不动，另立一条动作，另发一次请求。禁止按行业在执行器里写分支。

**生成要模型，执行不要。** 模型只产草稿（对象、关系、动作定义），人裁决、发布。执行器解释已发布配置，禁自由 SQL。画布上的再生成是人驱动的：拿上一版草稿加人的一句话，让模型再生成一次——`generateObject` 一次，草稿上画布，停。模型不自己选工具、不自己写库。

**循环分三种，只禁一种。** 禁止的是模型自转的 ReAct 循环：建模没有即时反馈信号，数据库不会告诉模型建错了，模型自己判自己对错只会漂移；每次循环走的路径不同，标注库回归就没法跑；循环的中间产物没人读，裁决权也就丢了。要保留的是人驱动的再生成，以及确定性流水线里嵌多个模型槽位：表多了逐批产类，由代码做确定性合并，再产关系建议与动作草稿——下一步走什么由代码决定，停不停由人决定，模型只在槽位里填空。槽位再多也落在「写出配置」这一个用途里；模型的另一个用途是把自然语言编成查询或写入请求，两个用途之外没有模型。真想要 agent 式探索，循环放在 Ontos 之外，由外部 Agent 驱动，Ontos 内部永远保持确定性。

**入口两个，内核同一套**：画布点「生成对象」走后端 `generateObject`；Claude Code 等外部 Agent 经 MCP 调 `propose_ontology` / `propose_action` / `query` / `run_action`。

**持久化与即用即弃**：本体、映射、动作定义、`log_query`、`log_action` 持久化；每次执行编出的 SQL 即用即弃；业务行留在原库。

**绕过平台的写**：源库被原地改动时，平台当时无感，下次读才看见。如果连这种变更也要进动作日志，就需要回调或 CDC；本期不做。

## 附录 A：本体论要素 × 本产品落地

| 本体论要素 | 一句话 | 现状 |
|---|---|---|
| 类（对象类型） | 领域里有哪些种东西 | 已落地。`object_types`，画布节点 |
| 属性 | 一类有哪些特征 | 已落地。界面上叫字段 |
| 关系 | 类与类怎么连 | 已落地。`link_types`：`match` 或 `transition`，含 `inverse`、`card` |
| 同一性标准 | 两条记录何时指向同一个体 | 已落地。`identity`，源条目可写 `key`；交集验证、跨源对齐、动作认人共用；界面上叫识别字段 |
| 个体（ABox） | 具体某台设备、某个人 | 不做。数据留源库，平台不存个体 |
| 类等价 | 两个名字指同一类 | 已落地。同一 → 单类挂多源 |
| 上位对象 | 部分重叠时抽出的公共类 | 已落地。属性上移，不带继承语义 |
| 生命周期 / 阶段 | 同一实体的时间阶段 | 已落地。派生属性 + `transition` 关系 + 转化动作 |
| 子类型（is-a） | 一类完全含于另一类 | 本期不做，不定案 |
| 同形异义 | 名字相同而所指不同 | 已落地。各自独立，互不映射 |
| 事物 / 事件 | 持续存在 / 发生过即确定 | 已落地。`kind`：thing 可经历阶段，event 不可 |
| 派生属性 | 不对应源列、读时现算 | 已落地。两种形状：`when` 列表谈源；一条过滤取布尔 |
| 可计算谓词 | 一个是非判断，如「是否在保」 | 已落地。即布尔派生属性 |
| 函数 | 给定对象唯一确定结果 | 不单设构造。逐个体的计算统一写成派生属性 |
| 部分与整体 | A 是 B 的部分 | 未做 |
| 公理 | 必须成立的约束 | 已落地。效应定完后、投影前校验；本期一种类型 `mutex` |
| 动作 | 一个对象允许发生什么变化 | 已落地。`pre` / `effect`，写回按 `sources` 推出 |
| 变更事件与告知 | 把变更发给没有映射的系统 | 已设计，本期不交付。`inform` + `outlets`，泛化的 `change` / `change_line` |
| 规则与推理 | 从已写下的事实推出没写下的事实 | 未做。只到派生属性的取值规则 |
| 形式语言 | OWL / RDF / 描述逻辑 | 未做。用 YAML |

## 附录 B：细节去《ontos-article.md》哪里读

| 本文章节 | 细节在哪 |
|---|---|
| §2 五种结论与三层证据链 | 文章 §3.2：五种结论的处理、三步判定、候选对、交集率 |
| §4 元模型骨架 | 文章附录 B：全部键、保留字、键的命名空间；附录 C：完整可发布配置 |
| §5 查询 | 文章 §5：请求写法、过滤语法、派生属性求值、多源对齐 |
| §5 写入 | 文章 §6：前置、效应、写回规则、转化关系判定、告知 |
| §8 红线 | 文章 §7：局限的完整论证 |
