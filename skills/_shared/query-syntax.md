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
