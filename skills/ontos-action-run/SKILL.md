---
name: ontos-action-run
description: 通过 MCP 对 Ontos 本体平台上的个体执行已发布动作（验收、调拨、报废、登记这类写源库的操作）。先查前置、再执行、再复查。当任务涉及 Ontos、本体/Ontology、对设备/订单等领域对象跑动作时使用。触发词：ontos、本体、ontology、执行动作、run_action、验收、调拨、报废。
---

# Ontos 执行动作（已发布世界 · 写源库）

Ontos 的写入**只能走已发布动作**——没有自由写接口。动作有前置，前置不满足会被拒绝。这个 skill 只做一件事：**对已发布快照上的个体执行已发布动作**。它写源库，风险与只读查询完全不同：前置核对、投影成败、部分失败不回滚，都是你的纪律。要查数用 `ontos-query`，要改画布用 `ontos-canvas`，要写动作定义用 `ontos-action`。

- 只执行**已发布**动作：画布草稿里还没发布的动作，`run_action` 不接受（业务失败）。不要去找"执行草稿动作"的办法，没有。
- **词汇封闭**：动作名、类名、参数名都必须来自 `read_class` 的返回，不许编造。

## 接入

<!-- BEGIN SHARED: mcp-access -->
- 端点：`POST <host>/api/<空间名>/mcp`（`<空间名>` 填当前工作空间名：内置演示模板空间是 `test`；三波走查用的是你自己新建的空间名，不要照抄 `test`）。
- 协议：JSON-RPC 2.0。会话开始 `initialize` 一次；`tools/list` 列工具；`tools/call` 调工具。`notifications/*` 不发响应（202）。
<!-- END SHARED: mcp-access -->
- 鉴权：`run_action` 是写操作——服务端设了 `ONTOS_TOKEN` 时，请求头必须带 `Authorization: Bearer <token>`，未授权返回错误码 `-32001`。`read_class` / `query` 只读放开。
- 错误都在信封里（HTTP 总是 200）：
  - `-32602` 入参形状不合法——检查 JSON 结构；
  - `-32000` 领域拒绝——`message` 是中文且指明错在哪，照着改；
  - 业务失败（如动作前置不满足）：`result.isError: true`，`structuredContent` 形如 `{ ok: false, stage: "pre", error: "前置不满足", projections: [] }`——`stage: "pre"` 表示卡在前置检查。

`tools/call` 的请求形状：

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "run_action", "arguments": { "action": "transfer", "object": "equipment", "identity": "SN-40083", "request": { "dept": "D07" } } } }
```

成功时读 `result.structuredContent`。

## 工具清单（本 skill 只用这三个）

| 工具 | 用途 | 入参 |
|---|---|---|
| `run_action` | 执行一条已发布动作 | `{ action, object, identity, request? }` |
| `read_class` | 读一个已发布类的视图：属性、关系、动作及前置（`pre` 里的 `$request` 块列出参数名和约束） | `{ name }` |
| `query` | 执行结构化查询（只读；前置核对与复查用） | `{ query: 查询JSON }` |

一律不传 `space`（这三个工具读的就是已发布世界；传了会被 `-32602` 拒绝）。不调用 `edit_draft` / `set_action` / `remove_action`，不碰草稿。

## 方法论（三步）：先查前置 → 执行 → 复查

1. **发现**：`read_class` 看目标类的动作与前置（`pre` 里的 `$request` 块列出参数名和约束，如 `dept: { object: "department" }` 表示 `request.dept` 必须能认到一个已存在的部门个体）。**先用 `query` 确认目标个体存在与当前状态**——前置不满足就直接告诉用户，不要发动作。例如对在途（`in_transit`）设备发 `transfer` 会得到 `isError: true, stage: "pre"`；此时正确做法是改用转化动作——阶段裁决立的动作名是 `convert_to_<晚阶段>`（如 `convert_to_in_service`，验收入库，前置正好是 `in_transit`），完成后再谈调拨。注意：附录 C 模板里的 `convert` 只属于 `test` 演示空间；动作名一律以 `read_class` 在你这个空间读到的为准。
2. **执行**：`run_action { action, object, identity, request? }`。前置不满足 = 业务失败：先查目标个体当前状态，确认哪条前置不满足，该修正修正、该放弃放弃——**不要原样重发**。
3. **复查**：执行成功后，用 `query` 查同一 `identity`，把最新状态展示给用户。**部分失败不回滚**——`structuredContent.projections` 是逐源表的投影成败清单（`source.table op ok/error`），有失败项时把明细如实报告给用户，补偿手段（修正后重发同一动作或人工修库）由人决定。

## 查询 JSON 语法（前置核对与复查用）

<!-- BEGIN SHARED: query-syntax -->
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
<!-- END SHARED: query-syntax -->

核对动作前置也用这套语法：演示四个动作的前置全含 `$link` 与嵌套子过滤。

## 动作 JSON 语法

```json
{ "action": "transfer", "object": "equipment", "identity": "SN-40217",
  "request": { "dept": "D07" } }
```

- `action` 必须是该类 `actions` 里已发布的一条；`identity` 是目标个体识别字段的取值；`request` 是动作参数。
- **参数从哪知道**：`read_class` 的 `actions[].pre` 里有 `$request` 块，列出参数名和约束。

## 完整剧本示范："把一台在役设备调拨到 D07"

1. `read_class { name: "equipment" }` → `transfer` 的前置：`status: in_service`、新部门不得等于当前部门、`$link.belongs_to: true`（得有部门）、`$request.dept` 必须认到部门。
2. **先找合适的目标**：`query { object: "equipment", filter: { status: "in_service", $link: { belongs_to: true } }, properties: ["serial_no", "dept"] }`——从结果里挑一台（如 `SN-40083`）。用户点名某台设备时也走这步：先查它的 `status` 和 `dept`，前置不满足就直接告诉用户，**不要发动作**。
3. 确认目标部门存在：`query { object: "department", identity: "D07", properties: ["name"] }`。
4. `run_action { action: "transfer", object: "equipment", identity: "SN-40083", request: { dept: "D07" } }` → `{ ok: true, projections: [{ source: "device", table: "device", op: "update", ok: true }] }`。
5. 复查：重发步骤 2 的 query（带上 `identity`），向用户展示 `dept` 已变成 `D07`。

## 红线

1. 只执行**已发布**动作；不调用 `edit_draft` / `set_action` / `remove_action`，不碰草稿。
2. 动作前置不满足就停下报给用户，不原样重试；动作部分失败时如实报告 projections 明细。
3. 发动作前先认个体存在与当前状态；`$request` 参数从 `read_class` 的 `pre` 里读，不编造。
4. 不编造类名、动作名、参数名、枚举值——拿不准就 `read_class` / `query`。
5. 同一次会话里 `initialize` 只做一次；`notifications/*` 等不到响应是正常的。
