---
name: ontos
description: 通过 MCP 接入 Ontos 本体平台，按已发布本体查业务数据（组装结构化查询 JSON）或对个体执行已发布动作（组装动作 JSON）。当任务涉及 Ontos、本体/Ontology、按类查数、跨源数据对齐、或对设备/订单等领域对象执行验收、调拨、报废这类动作时使用。触发词：ontos、本体、ontology、问数、结构化查询。
---

# Ontos：本体数据平台

## 它是什么（先建立心智模型）

Ontos 把一份**本体**（YAML 配置：类、属性、关系、动作）盖在已有数据库之上。你面对的不是表，而是**类**（如"设备""部门"）；每个类有属性（含枚举值、派生属性），类之间有关系，类上挂着已发布的动作。

信任边界，必须遵守：

- **查询是只读的**，实时查源库；你拿不到、也不许尝试拿库连接。
- **写入只能走已发布动作**——没有自由写接口。动作有前置，前置不满足会被拒绝。
- **词汇封闭**：查询和动作里出现的每个名字（类、属性、关系、枚举值）都必须来自本体。本体内容通过下面的工具读取，**不许编造、不许猜测**。

## 接入

- 端点：`POST <host>/api/mcp?ws=<空间名>`（`ws` 省略即 `default`）
- 协议：JSON-RPC 2.0。会话开始 `initialize` 一次；`tools/list` 列工具；`tools/call` 调工具。`notifications/*` 不发响应（202）。
- 鉴权：读操作放开；写操作（`run_action`）仅当服务端设了 `ONTOS_TOKEN` 时需要请求头 `Authorization: Bearer <token>`，未授权返回错误码 `-32001`。
- 错误都在信封里（HTTP 总是 200）：
  - `-32602` 入参形状不合法——检查 JSON 结构；
  - `-32000` 领域拒绝——`message` 是中文且**指明错在哪、合法值是什么**，照着改；
  - 业务失败（如动作前置不满足）：`result.isError: true`，`structuredContent` 形如 `{ ok: false, stage: "pre", error: "前置不满足", projections: [] }`——`stage: "pre"` 表示卡在前置检查。

`tools/call` 的请求形状：

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "query", "arguments": { "query": { "object": "equipment" } } } }
```

成功时读 `result.structuredContent`（同一份 JSON 也在 `result.content[0].text` 里）。

## 工具清单

| 工具 | 用途 | 入参 |
|---|---|---|
| `search` | 按文本检索类名与关系名 | `{ text }` |
| `list_classes` | 列出全部类（名字+说明） | `{}` |
| `read_class` | 读一个类的完整视图：属性（**枚举附 values**）、关系、动作及前置 | `{ name }` |
| `query` | 执行结构化查询（只读） | `{ query: 查询JSON }` |
| `run_action` | 执行一条已发布动作 | `{ action, object, identity, request? }` |
| `propose_ontology` | 对选中的表产本体草稿建议 | `{ tables: [{ connection, table }] }` |
| `propose_action` | 对某类产一条动作定义草稿 | `{ object }` |

## 总方法论：发现 → 组装 → 执行 → 纠错

**永远不要直接凭用户的话组 JSON。** 按这四步走：

1. **发现**：用户说的概念对应哪个类？`search` 或直接 `list_classes`。找到类名后 `read_class`——它给你：属性名和类型、**枚举的合法取值**（`values`）、从该类出发的关系名（含反向名）、动作名及前置。
2. **组装**：严格用读到的名字组查询/动作 JSON。filter 的枚举值从 `values` 里选，关系名从 `relations` 里选。
3. **执行**：`query` 或 `run_action`。
4. **纠错**：失败时读错误消息修正后重发。`-32000` 的 message 会点名错处（如"名字对不上配置：equipment.statuss"——属性名拼错；"order 里的名字对不上配置：started_at"——排序字段没放进 `properties`），这正是给你修的，修一次通常就对。**同一个错误不要原样重发。**

拿不准某个枚举值/字段取值分布时，可以先发一个不带 filter 的 `query` 探一下实际数据，再组带 filter 的正式查询。

## 查询 JSON 语法

```json
{
  "object": "equipment",                      // 必填。根类：从哪个类查
  "identity": "SN-40217",                     // 可选。认准一个体（识别字段的取值）
  "properties": ["name", "status"],           // 可选。只取这些属性；省略=返回全部属性（含派生），空值属性不出现
  "filter": { ... },                          // 可选。见下
  "order": { "name": "asc" },                 // 可选。单键 asc/desc；排序字段必须是返回的属性（在 properties 里；不写 properties 则任意属性均可）
  "limit": 50,                                // 可选。默认 200，最大 1000
  "aggregate": { ... },                       // 可选。分组统计，见下
  "expand": [ ... ]                           // 可选。按关系展开，见下
}
```

### filter：对象逐键 AND

- **裸字面量 = 等值**：`{ "status": "in_service" }` 即 `{ "status": { "eq": "in_service" } }`。
- **运算符块**：`eq ne lt lte gt gte in contains`，可组合：`{ "expiry": { "gte": "now/d" } }`。`in` 的值必须是数组：`{ "dept": { "in": ["D01", "D07"] } }`；`contains` 是子串匹配；比较运算（lt/gt 等）只对数字和日期生效。
- **判空**：`{ "ended_at": null }` 为空，`{ "ended_at": { "ne": null } }` 非空。日期属性上"空"语义是"至今"：如 `valid_to` 为空表示至今有效，比较时按无穷晚处理。
- **日期值**：写 ISO 串（`"2026-01-01"`）或 now 表达式——锚点只有 `now`，步进 `+1d`/`-30d`，取整 `/d /h /m /s /w`，如 `"now"`（此刻）、`"now/d"`（今天 0 点）、`"now-30d/d"`（30 天前 0 点）。单位：`y M w d h m s`。
- **关系条件收在 `$link`**：`{ "$link": { "<关系名>": true } }` 存在关联；`false` 不存在关联；给子过滤对象表示"存在满足该过滤的关联个体"：

```json
{ "object": "equipment",
  "filter": { "$link": { "covered_by": { "expiry": { "gte": "now/d" } } } } }
// 有到期日不早于今天的保修卡的设备（=在保）
```

- 关系名必须用**从根类出发能用的那个名字**（正向名或反向名），`read_class` 的 `relations` 列出来的就是可用的。`$link` 嵌套最多三层。
- **查询里禁止 `$request` 和 `$exists`**（它们只属于动作前置），否则被 `-32000` 拒绝。

### aggregate：分组统计（与 expand 互斥）

```json
{ "object": "equipment",
  "filter": { "status": "in_service" },
  "aggregate": { "group_by": ["dept"], "metrics": [{ "count": "*" }] } }
```

- `metrics` 每条一个键：`count`（`"*"` 数行，写字段名数非空值）、`avg` `sum` `min` `max`（跟数值字段名）。
- 返回分组行，不返回个体明细；**同给 `expand` 会被拒绝**。

### expand：按关系展开（最多三层）

```json
{ "object": "equipment",
  "filter": { "status": "in_service" },
  "properties": ["name"],
  "expand": [{ "relation": "belongs_to", "properties": ["name"] }] }
```

返回的每个个体上多一个以关系名为键的数组字段（如 `belongs_to: [{ name: "仓储部" }]`）。`expand` 节点自己还能带 `filter` 和下一层 `expand`。

## 动作 JSON 语法

```json
{ "action": "transfer", "object": "equipment", "identity": "SN-40217",
  "request": { "dept": "D07" } }
```

- `action` 必须是该类 `actions` 里已发布的一条；`identity` 是目标个体识别字段的取值；`request` 是动作参数。
- **参数从哪知道**：`read_class` 的 `actions[].pre` 里有 `$request` 块，列出参数名和约束。如 `dept: { object: "department" }` 表示 `request.dept` 必须能认到一个已存在的部门个体——发动作前最好先用 `query` 确认该个体存在。
- **前置不满足 = 业务失败**：`isError: true`，`error` 说明哪条前置没满足。**不要原样重发**；先 `query` 查目标个体的当前状态，确认哪条前置不满足，该修正修正、该放弃放弃。
- **结果解读**：`structuredContent.projections` 是逐源表的投影成败清单（`source.table op ok/error`）。**部分失败不回滚**——有失败项时把明细如实报告给用户，补偿手段是修正后重发同一动作或人工修库，由人决定。
- 动作成功后，可以发一个 `query` 查同一 `identity`，把最新状态展示给用户作为复查。

## 完整剧本示范

### 剧本一：聚合问数——"每个部门多少台在役设备？"

1. `search { text: "设备" }` → 类 `equipment`。
2. `read_class { name: "equipment" }` → `status` 是枚举，`values: [in_transit, in_service, scrapped]`；`dept` 是部门编号。
3. 组装：`{ object: "equipment", filter: { status: "in_service" }, aggregate: { group_by: ["dept"], metrics: [{ count: "*" }] } }`。
4. `query` 执行 → `structuredContent.rows` 是分组结果，`path` 是取数路径（可展示给用户，说明数据来自哪些源库）。

### 剧本二：动作——"把一台在役设备调拨到 D07"

1. `read_class { name: "equipment" }` → `transfer` 的前置：`status: in_service`、新部门不得等于当前部门、`$link.belongs_to: true`（得有部门）、`$request.dept` 必须认到部门。
2. **先找合适的目标**：`query { object: "equipment", filter: { status: "in_service", $link: { belongs_to: true } }, properties: ["serial_no", "dept"] }`——从结果里挑一台（如 `SN-40083`）。用户点名某台设备时也走这步：先查它的 `status` 和 `dept`，前置不满足就直接告诉用户，**不要发动作**。例如对在途（`in_transit`）设备发 `transfer` 会得到 `isError: true, stage: "pre", error: "前置不满足"`；此时正确做法是改用 `convert`（验收入库，前置正好是 `in_transit`），完成后设备进入在役，再谈调拨。
3. 确认目标部门存在：`query { object: "department", identity: "D07", properties: ["name"] }`。
4. `run_action { action: "transfer", object: "equipment", identity: "SN-40083", request: { dept: "D07" } }` → `{ ok: true, projections: [{ source: "device", table: "device", op: "update", ok: true }] }`。
5. 复查：重发步骤 2 的 query（带上 `identity`），向用户展示 `dept` 已变成 `D07`。

## 红线

1. 不编造类名、属性名、关系名、枚举值——拿不准就 `search` / `read_class`。
2. 查询 filter 里不写 `$request` / `$exists`；聚合与 `expand` 不同给；`expand` 不超过三层；`limit` 不超过 1000。
3. 动作前置不满足就停下报给用户，不原样重试；动作部分失败时如实报告 projections 明细。
4. 同一次会话里 `initialize` 只做一次；`notifications/*` 等不到响应是正常的。
