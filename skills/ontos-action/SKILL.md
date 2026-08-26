---
name: ontos-action
description: 通过 MCP 在 Ontos 本体画布的工作副本（草稿）里编写动作定义（set_action / remove_action）：前置、效应、告知。当任务涉及 Ontos、本体/Ontology、写动作、定义动作、转化动作时使用。触发词：ontos、本体、ontology、写动作、动作定义、set_action。
---

# Ontos 写动作定义（草稿世界 · 写）

动作定义写在草稿里，**写完不生效**：`run_action` 只执行已发布快照上的动作，人在画布上点「发布」才生效。发布、放弃、裁决都是人的关卡，**没有这些工具，也不要去找**。

这个 skill 只写动作定义。改对象/字段/关系归 `ontos-canvas`；执行动作归 `ontos-action-run`；查数归 `ontos-query`。

## 接入

<!-- BEGIN SHARED: mcp-access -->
- 端点：`POST <host>/api/<空间名>/mcp`（`<空间名>` 填当前工作空间名：内置演示模板空间是 `test`；三波走查用的是你自己新建的空间名，不要照抄 `test`）。
- 协议：JSON-RPC 2.0。会话开始 `initialize` 一次；`tools/list` 列工具；`tools/call` 调工具。`notifications/*` 不发响应（202）。
<!-- END SHARED: mcp-access -->

工具入参不带空间名。
- 鉴权：`edit_draft` 是写操作——服务端设了 `ONTOS_TOKEN` 时，请求头必须带 `Authorization: Bearer <token>`，未授权返回 `-32001`。发现类工具只读放开。
- 错误都在信封里（HTTP 总是 200）：`-32602` 入参形状不合法；`-32000` 领域拒绝（message 中文、指明错在哪——「效应 link 指向不存在的转化关系」「删掉转化关系唯一引用动作」「取值来源不认识」都按 message 改）；`-32001` 缺写令牌。

## 工具清单（本 skill 只用这些）

| 工具 | 用途 | 入参 |
|---|---|---|
| `list_classes` | 列草稿里的类（顺带拿 `outlets`——inform 的合法出站名列表） | `{ space: "draft" }` |
| `read_class` | 读草稿里一个类的完整动作定义（`actions[].def` 原样，可读回-改-写回）与关系 | `{ name, space: "draft" }` |
| `propose_action` | 对某个类产一条动作建议（不落地）。返回 `{ name, action }`。**一律传 `space: "draft"`**——缺省读已发布，对草稿类会空转 | `{ object, space: "draft" }` |
| `edit_draft` | 落地动作定义（op 只用 `set_action` / `remove_action`），必带 `base_rev` | `{ op, ...，base_rev }` |

发现类工具必须传 `space: "draft"`。`edit_draft` 不接受 `space`。

## 方法论（四步）：看现有动作 → 取模板或读回 def → 完善 → 落地请人发布

1. **发现**：`list_classes { space: "draft" }`（拿 `rev` 与 `outlets`）→ `read_class { name, space: "draft" }` 看该类现有动作（完整定义）与关系。
2. **组装**：`propose_action { object, space: "draft" }` 拿模板——返回 `{ name, action }`，`action` 直接作 `set_action.def`。类上已有转化关系时给 `convert_to_<晚阶段>` 转化模板，否则给 `set_fields` 骨架（属性已从类定义接好，与导入时自动生成的那条同形同名）。带前置的业务动作（调拨、报废）在这个骨架上补前置、调效应。**要改现有动作**：从 `read_class` 的 `actions[].def` 读回完整定义，改完塞回 `set_action.def`（同名覆盖）——不要盲覆盖。**要删**：`remove_action`。
3. **应用**：`edit_draft { op: "set_action", object, name, def, base_rev }`。失败读 `-32000` 的 message 修 `def` 再发；「草稿已变」就重新拿 `rev`。
4. **停下**：告诉人「草稿已改，画布上该类的动作区会显示新动作、发布条会点名变化；生效请点发布」。

## 动作定义骨架（附录 B，唯一合法形状）

一条动作定义（`set_action` 的 `def`）：

```yaml
description: 一句话说明（可选）
pre:                        # 前置（可选）：缺省或 {} = 无前置
  属性名: 值                 # 本类属性 = 字面量；{ ne: 值 } = 不等于
  $link: { 关系名: true }    # 关系已发生（true）/ 未发生（false）/ 子过滤对象
  $request:                  # 请求参数约束（可选）
    参数名: { object: 类名 }  # 该参数必须能认到这个类的一个体
effect:                     # 效应（必填，非空列表），四项：
  - update:                 # 改已有个体的字段
      object: 类名
      identity: { from: identity }   # 认人必须写明：identity 或 filter 二选一
      properties: { 属性名: 取值 }
  - create:                 # 新生一个个体
      object: 类名
      properties: { 属性名: 取值 }
  - delete:                 # 撤走已有个体
      object: 类名
      identity: { from: identity }   # 或 filter: {...}
  - link: 转化关系名          # 转化：只许指向本类上已存在的 transition 关系，没有另一端
inform:                     # 告知（可选）：先把变更事件发给谁
  - object: 事件类名
    to: [出站名]             # 必须在 list_classes 的 outlets 里已声明
    properties: { 属性名: 取值 }
```

**取值**（properties 与认人键里）：字面量；`{ from: "request" }`（请求同名参数）；`{ from: "identity" }`（请求顶上的识别值）；`{ from: "action" }` / `{ from: "object" }`（请求顶上的动作名/类名）；`{ property: 名, from: "current" }`（当前个体的属性，只许 update 的 properties 与 update/delete 的 filter）；`{ from: "generated" }`（只许 create 且目标属性带 `generate` 列表——按规则发号）；日期表达式 `now` / `now/d` / `now+1y`（锚点只有 now，单位 `y M w d h m s`）。

铁律：

- 请求点名的那个体，效应写 `object` + `identity: { from: "identity" }`；其他已有个体写 `object` + `filter`。**不许省略 `object`，不许 `$root`。**
- 动作上不写 `write` 名单；写回按效应和 `sources` 推出。
- **转化关系由裁决独占**：`create_link` 不收 `transition`，你造不出转化关系；效应 `link` 只能指向已有的转化关系。
- 删掉转化关系的唯一引用动作会被引擎拦（转化成对）。**逃生路径**：先 `set_action` 一条同样 `link` 该转化关系的替代动作，再 `remove_action` 删旧的——转化关系本身被引用保护，`delete_link` 删不掉。
- `import_objects` / `replace_object` 的类体会被剥掉 `actions`——新类的动作也要另走 `set_action`，不要整份塞 `actions` map，不臆造 `set_actions`。
- 写带 `inform` 的动作前，先从 `list_classes { space: "draft" }` 的 `outlets` 确认出站已声明；没出站就去掉 `inform`，不编造出站名。空白空间（default 与新建空间）没有出站。

## 示例：给 department 加一条「停用」动作

```json
{ "op": "set_action", "object": "department", "name": "deactivate",
  "def": {
    "description": "停用部门",
    "pre": { "active": { "ne": false } },
    "effect": [{ "update": { "object": "department", "identity": { "from": "identity" }, "properties": { "active": false } } }]
  },
  "base_rev": 12 }
```

## 红线

1. 写动作只走 `set_action` / `remove_action`（经 `edit_draft`，必带 `base_rev`）。
2. 动作写进草稿不等于生效；不调用、不臆造 `publish` / `discard` / `decide` / `rollback` 工具。
3. 同名覆盖现有动作前，先 `read_class { space: "draft" }` 读回完整定义确认要改什么。
4. 转化关系由裁决独占：不造转化关系；删转化动作走「先替代、再删」。
5. 不编造类名、属性名、关系名、出站名——拿不准就 `read_class` / `list_classes`（都带 `space: "draft"`）。
6. 同一次会话里 `initialize` 只做一次；`notifications/*` 等不到响应是正常的。
