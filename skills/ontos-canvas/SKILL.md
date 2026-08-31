---
name: ontos-canvas
description: 通过 MCP 编辑 Ontos 本体画布的工作副本（草稿）：把表建成对象、增删字段、建关系、改阶段（时期）、整份替换未锁定的类。当任务涉及 Ontos、本体/Ontology、逆向建模、改画布、加对象/字段/关系、改阶段/时期时使用。触发词：ontos、本体、ontology、改画布、建模、生成对象、阶段、时期、edit_draft。
---

# Ontos 改画布（草稿世界 · 读写）

画布上的内容 = 工作副本（草稿）：已发布 + 没发布的改动。你经 `edit_draft` 写的就是这份草稿——**写完不生效**：问数（`query`）与已发布动作（`run_action`）只读已发布快照，人在画布上点「发布」才生效。**判定与整合是你的职责**：按证据定唯一键、算交集率、该合并的合并、该连线的连线，全部落草稿——画布与留痕视图让人看见你的每个决定与证据。发布与放弃是人的动作，**没有这两个工具，也不要去找**。

这个 skill 管对象/字段/关系/阶段/导入/整份替换。写动作定义（`set_action` / `remove_action`）归 `ontos-action`；查数归 `ontos-query`；执行动作归 `ontos-action-run`。

## 接入

<!-- BEGIN SHARED: mcp-access -->
- 端点：`POST <host>/api/<空间名>/mcp`（`<空间名>` 填当前工作空间名：内置演示模板空间是 `test`；三波走查用的是你自己新建的空间名，不要照抄 `test`）。
- 协议：JSON-RPC 2.0。会话开始 `initialize` 一次；`tools/list` 列工具；`tools/call` 调工具。`notifications/*` 不发响应（202）。
<!-- END SHARED: mcp-access -->

**工具入参不带空间名**；空间只由 URL 决定。人开着哪个空间的画布，你就用哪个 `workspace`，不然人看不见你的改动。
- 鉴权：`edit_draft` 是写操作——服务端设了 `ONTOS_TOKEN` 时，请求头必须带 `Authorization: Bearer <token>`，未授权返回 `-32001`。发现类工具只读放开。
- 错误都在信封里（HTTP 总是 200）：
  - `-32602` 入参形状不合法——缺 `base_rev`、`base_rev` 是字符串、`space` 传错工具，都在这档；
  - `-32000` 领域拒绝——`message` 是中文且**指明错在哪**（重名、不存在、被引用、锁定、rev 冲突），照着改；
  - `-32001` 未授权——缺写令牌。

`tools/call` 的请求形状：

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "edit_draft", "arguments": { "op": "add_property", "object": "department", "name": "dept_name", "type": "string", "base_rev": 12 } } }
```

成功时读 `result.structuredContent`：`{ ok, dirty, rev, base_version, op, names }`。

## 工具清单（本 skill 只用这些）

| 工具 | 用途 | 入参 |
|---|---|---|
| `list_tables` | 列出已连接库里的表和列（只读列定义，没有采样行） | `{ connection? }` |
| `propose_objects` | 对选中的表产对象建议（**不落到画布**） | `{ tables: [{ connection, table }] }` |
| `propose_key` | 对一个类出唯一键建议（数据试算 + 语义判别） | `{ object }` |
| `list_classes` | 列草稿里的类（带 `state` / `dirty` / `rev` / `outlets` / 唯一键 `identity`） | `{ space: "draft" }` |
| `read_class` | 读草稿里一个类的字段、关系、来源对照、能不能整份替换（`replaceable` / `replace_blockers`） | `{ name, space: "draft" }` |
| `search` | 在草稿的类名、说明、关系名里检索 | `{ text, space: "draft" }` |
| `list_candidates` | 列出召回的疑似重复对与证据（判定的参考） | 无入参 |
| `compute_overlap` | 算候选对的交集率（判定的硬证据） | `{ class_a, class_b }` |
| `decide` | 落判定结论：合并 / 建链 / 时期（写草稿与留痕） | `{ class_a, class_b, verdict, ... }` |
| `edit_draft` | 改草稿，一次只改一步 | `{ op, ...，必带 base_rev }` |

**发现类工具必须传 `space: "draft"`**——缺省读已发布，你会看不见人还没发布的改动，也会盖掉它们。`list_tables` / `list_candidates` / `propose_objects` / `edit_draft` **不接受** `space`（传了 `-32602`）。

## 方法论（五步）：发现草稿 → 组装 op → 应用 → 整合 → 停下请人发布

1. **发现（草稿）**：`list_classes { space: "draft" }` 拿类清单和 **`rev`**；`read_class { name, space: "draft" }` 看字段与来源对照。需要表名时用 `list_tables`，不要编连接名。`query` 读的是已发布快照，**不能当画布真相**。
2. **组装**：严格按下表拼**一条** op。从某张表建新对象：先 `propose_objects`（只建议，不写草稿），检查类名是否已在草稿里。
3. **应用**：`edit_draft`，带上刚读到的 `rev` 作为 `base_rev`。`-32000` 说「草稿已变」就是 rev 过期——重新 `list_classes { space: "draft" }` 拿新 `rev` 再发；别的 `-32000` 读 message 修 op 再发。**同一个错误不要原样重发。**
4. **整合（你的职责，见下节）**：定唯一键 → 算交集率 → 按问题树落判定（合并 / 建链 / 各自独立），全部经工具落草稿；拿不准的留着不裁，画布上人看得见。
5. **停下**：告诉人「草稿已改、整合已做，请到画布上审；要问数/动作生效，请在画布上点发布」。**不要**寻找发布、放弃、回滚的工具——那是人的动作。

## 整合（你的职责）：定键 → 算交集 → 落判定

有来源的对象上画布之后，按这个顺序自己做，不要交回去。同一库的两张表也可能成对。

1. **定唯一键**：先分行——行是个体本身（或其时期）的类，取个体编号列；行是关于个体的记录（工单、卡）的类，取自己的单号列。数据试算用 `propose_key`（命中作参考：记录表身上指向他类的编号列命中越多，越证明它是引用、不做身份）。定了就 `edit_draft set_identity` 落草稿。
2. **算交集**：`compute_overlap` 对候选对取硬证据（归一化后两端取值的集合重合）。0% 与 100% 都是硬结论的依据。
3. **落判定**：按问题树走——是同一个概念（同一批个体或其时期）→ `decide` 合并（不同时期带时期参数）；不是同一个概念 → 有没有关联（一边的字段指向另一边的个体）？有 → 建链（`create_link`，match 用配对字段，链名起领域谓词）；没有 → 各自独立（`decide` 同形异义）。拿不准的留着不裁，人在画布上看得见。
4. **对人说清楚**：你落了哪些判定、依据是什么（交集率、命中的字段）——留痕视图里每条都可查、可回滚。然后请人到画布审；发布由人点。
5. **转化关系不归你造**：生命周期判定经 `decide` 落地时由引擎立（状态字段、转化关系、转化动作一套），不要用 `create_link` 去造。

## edit_draft 的 op 一览（一次调用一条，不收数组）

| op | 关键入参 | 说明 |
|---|---|---|
| `create_object` | `{ name, kind: "thing"\|"event", description? }` | 新建空对象（手工建模，无来源） |
| `delete_object` | `{ name }` | 删对象，挂着它的关系一起撤；删已发布类只进草稿，发布才生效 |
| `update_object` | `{ name, description?, new_name? }` | 改对象说明或对象名（改名跟着关系和摆位走） |
| `edit_stages` | `{ object, items: [{ value, when, label? }] }` | 改阶段列表（条数与现有规则相同）：时期标识、顺序、中文名（label，只给人看，缺了=清掉）；改标识会联动改写值域与派生规则、转化关系两端与自动名、动作前置里的平铺等值字面量（嵌套运算符里的不跟） |
| `add_property` | `{ object, name, type, description?, values? }` | 加字段；type ∈ `string/number/boolean/date/enum` |
| `remove_property` | `{ object, name }` | 删字段（被引用的拒） |
| `update_property` | `{ object, name, new_name?, type?, values?, description? }` | 改字段 |
| `set_identity` | `{ object, name }` | 设唯一键字段（name 空串 = 取消） |
| `create_link` | `{ name, from, to, match: { from, to }, inverse?, card?, description? }` | 建关系；只收配对（match），**转化关系由生命周期判定独占**。`name` 必须是领域谓词——回答一个领域问题（如 on_equipment：维修的是哪台设备）；机器拼名（{a}_to_{b}）不收，起不出名字回问人 |
| `delete_link` / `update_link` | `{ name }` / `{ name, new_name?, description?, inverse? }` | 删/改关系（被引用的拒） |
| `import_objects` | `{ objects: { 类名: 类体 } }` | 整批导入新类；撞名整批拒。类体里的 `actions` / `axioms` 会被剥掉（动作走 `ontos-action`） |
| `replace_object` | `{ name, def: 类体 }` | 整份替换**未锁定**的类；关系与摆位保留 |

`replace_object` 的 `def` **只**取 `propose_objects` 返回的 `object_types[类名]`（单个类体，不是整张 map）。禁止把 `read_class` 的返回塞回去（那是视图，形状不合法）。锁定规则（`read_class` 的 `replace_blockers` 会列出来）：已经发布过 / 含派生字段 / 含动作 / 含公理 / 挂了多个来源 / 有来源且含未对照到表列的字段——命中一条就拒，改走 `add_property` 等逐步操作。

把建议写进草稿的分支（不要发明第三条路）：

```
propose_objects 得到 object_types
  ├─ 草稿里没有这个类名 → edit_draft import_objects
  └─ 草稿里已有这个类名 → read_class 看 replaceable
       ├─ true  → edit_draft replace_object（def = object_types 里那个类体）
       └─ false → 逐步 add_property / update_object / set_identity，或告诉人去画布改
                  不要另起一个同义类名，不要 delete_object 再 import_objects
```

## 红线

1. 不 `query` / `run_action`；不把它们的返回当作画布内容。写动作归 `ontos-action`：`edit_draft` 只用上表的对象/字段/关系/导入/替换 op，不用 `set_action` / `remove_action`。
2. 不把 `read_class` 的返回塞进 `replace_object.def`。
3. 没挂来源的类可以整份替换（残缺生成靠这个补来源）；一换会盖掉人在这个类上加的字段——人已经在画布上改过就改用逐步操作。
4. 不对已锁定类（含已经发布过的类）`delete_object` 再 `import_objects` 来绕过锁定（会拆关系）。引擎不拦这条路，靠这条红线和人点发布/放弃。
5. 不调用、不臆造 `publish` / `discard` / `rollback` / `save_layout` 工具——发布与放弃是人点；摆位（节点位置）不归你写。
6. 不编造类名、字段名、连接名、表名——拿不准就 `list_classes space=draft` / `list_tables`。
7. `query` / `run_action` / `propose_objects` / `edit_draft` / `list_tables` / `list_candidates` 不要传 `space`。
8. 同一次会话里 `initialize` 只做一次；`notifications/*` 等不到响应是正常的。
