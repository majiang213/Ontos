## Design Document Review: 外部 Agent 编辑画布（对齐附录 B）

### Summary
Verdict: **approve**

上一轮三个补丁都落干净，没有新的 major / critical。

1. **认人键只写在 `update` / `delete`。** Goal 1、Key Decision 13、字段表 ①④ 同一口径：保存这两项才自动写 `object` + `identity: { from: identity }`、无 `filter`。`create` 与 `link` 明确没有这个键（新建没有已有个体可认，转化只写关系名）。不再用「效应」一词把三项盖住。
2. **`delete` 是宿主类 + 请求点名的那个体。** 字段表 ④、`formCompatible` 的 `delete` 都要求 `object` 是宿主类；Agent 写的跨类删除无「编辑」。`validateActionShapes` ④：每条 `update` / `delete` 必须有 `identity` 或 `filter`，不许都缺；表单路径自动写，Agent 缺了 `DraftReject`，不等发布后执行。效应摘要 `撤走 <object>`，列表按钮仍叫「删除」。
3. **放弃文案去掉「Agent」；`apply_draft` 的 `tools/list` 不再写对象卡、不再「见 Goal 1」。** 工具说明只讲 op 清单与 `base_rev`。PR 2 仍不提动作 op，PR 3 按 §1 表现在这张表补全。

点名要攻的六处，主路径都站得住：

| 攻点 | 结论 |
|---|---|
| 请求 vs 定义 | 分开。§2.2 写入请求 `{ action, object, identity, request? }`；定义是 `description` / `pre` / `effect` / `inform`。`actionSchema` 校验定义，不校验请求。表单「不是写入请求的编辑器」。编号在执行请求里点名，不在表单里填。 |
| 表单 vs 附录 B | 诚实子集。`update`/`delete` 只覆盖请求点名的那个体；`create` 必须有 `object`（选已有类）；`link` 只选已有转化、没有另一端；`properties` 只收非派生源列（`update` 写明）；不做 `inform`、不加 `write`、不引入 `$root`、不新开本体键。演示五条 `formCompatible` 钉为假。 |
| Goal 1 是否多写 | 没有。认人自动写收成 ①④；控件不出现认人；五条超出子集与 Non-Goals / Open Questions / Alternatives I 同一把尺子。 |
| `apply_draft` 说明 | 无对象卡、无 Goal 1。改画布的模型读不到「去对象卡上点」。 |
| 用户可见大白话 | 按钮「新建动作 / 编辑 / 删除」、芯片「新增 / 已修改」、效应种类「把字段写成某值」、摘要「撤走」已按 AGENTS.md 钉完。放弃确认无「Agent」。 |
| 放弃 confirm | 无「Agent」。句子还按作者拆动作/字段，见本期 nits。 |

还开着的都是文档齐套与 PR 3 冻进 `CanvasPage` 的边角，不挡「人按新建占位保存一条改 mark」这条主路径，也不挡 Agent 按附录 B 写演示五条。无新本体键。

---

### Previous issues
- Issue 1（Goal 1 把认人键说成全部效应都带；`formCompatible` 的 `delete` 没写宿主类；`validateActionShapes` ③ 不要求认人出现）— **addressed** — Goal 1 / KD 13 / 字段表只给 `update`/`delete` 写认人；`delete` 谓词要求宿主类；④ 补上 `identity` 或 `filter`。开头「补三处缺口」与 Risks「三项」是漏改，见本期 nit。
- Issue 2（放弃有「Agent」；保存「覆盖」；Esc 无句；摘要「删除」撞列表「删除」；控件栏 YAML）— **partial** — 「Agent」已删；摘要改「撤走」、列表保持「删除」。保存「覆盖」、Esc / 切对象仍无句子、控件栏仍是键名，见本期 nit。
- Issue 3（`apply_draft` 说明写对象卡与「见 Goal 1」）— **addressed** — §1 表现在只列 op。Overview 仍写「新建/改/删」不带「简单」、摘要仍写「删除某某」，见本期 nit。
- 更早：`formCompatible` 缺认人 / `now` 系不全 / 删除下拉未钉本类；演示五条与「同权」打架；表单会话无 Esc；REST 不带 `base_rev` 盖 Agent；「画布没有动作编辑器」；列表「改」撞名；人加删除效应仍一键发布；动作语言安在 `actionSchema` 上 — **addressed**（PR 3 反窗口仍 **accepted**，不单开）。

---

### Issue 1: PR 3 将冻进界面的句子，以及补丁未改到的齐套
- **Severity**: nit
- **Section**: Overview；§2.2 规则 3 首句；§6 放弃 / Esc / 保存 confirm；字段表「控件」栏；Key Decision 15；Risks / Security 11；`formCompatible` 的 `create`
- **Description**: 口径已经能写对、能拦错。下面这些不会让 `create` 带上认人键，也不会让跨类删除亮「编辑」。它们会在 PR 3 进 `CanvasPage` 或让后排段落和 §6 表打架。

  1. **放弃仍按作者拆。** 现句：「放弃会连别人刚写的动作和你改的字段一起没。确定放弃？」无「Agent」，上一轮那条已满足。放弃丢掉的是整份草稿：自己在对象卡上新建的动作不是「别人刚写的」，外面改来的字段也不是「你改的」。按作者拆会让人以为自己写的动作还在。

  2. **Esc / 切对象 / 对象被删仍只有「则 `confirm`」，没有句子。** 保存撞 `rev` 仍是「还要按表单覆盖吗？」。实现者会现场写出工作副本 / 覆盖 / Agent。同节 toast 已经能写「外面刚写的」「按表单里的来」。

  3. **「表单白话字段」的控件栏仍是配置骨架。** ① 值=`{ from: request }`；③ `{ from: identity }`＝请求顶上的识别值。这一栏是给人看的格子，不是「写成配置」栏。`{ from: identity }` 在这里是取值来源（请求顶上那个值），不是 `update`/`delete` 条上的认人键，更不是「识别字段」。Goal 1「控件上不出现认人」与 ③ 并排时，实现若把「识别值」写进下拉，用户看见的就是认人。效应种类只钉了「把字段写成某值」和「转化」；④ 的控件写成「撤走本类、请求点名的那个体」——「本类 / 请求点名」进格子就踩 AGENTS.md。「源列属性」同理，标签说「不是派生的字段」即可。

  4. **Overview / KD 15 没跟上「撤走」。** Overview：「人在对象卡上新建/改/删」「摘要（含「删除某某」）」。Goal 3 / Non-Goals / §6 表已经带「简单」且摘要是「撤走」。KD 15 仍写 `effectSummary`（含「删除」）。实现从 Overview 起读，会把表单做成附录 B 全集，并把摘要做成第二个「删除」。

  5. **规则 3 开头「补三处缺口」；Risks / Security 仍写校验「三项」。** 同段已经是 ①②③④，PR 3 的 `validate.ts` 也写「补四处」。认人闸是 ④，不是 Zod：`actionSchema` 不能把 `identity` 做成必填（另一条路是 `filter`）。「认人必须写明。`actionSchema` 就是这份规则」还粘在一起，会有人去 schema 里给 `create` 也加 `identity`。PR 3 测试清单列了 `link` / 成对 / 取值来源回退，没有钉「缺 `identity` 且缺 `filter` 的 `update`/`delete` → `DraftReject`」。

  6. **`formCompatible` 的 `create` 比 `update` 松一档。** `update` 写了属性名非派生源列。`create` 只写取值白名单。附录 B：`update` / `create` 的 `properties` 都只接受源列属性。派生字段进不了草稿（`validateSemantics`），点「编辑」丢键的窗口实际上没有。谓词与保存结果对齐的话，`create` 应同样要求：有 `object`、属性非派生源列。

  请求与定义没有混回 `actionSchema`。表单没有给 `create`/`link` 发明认人键。`apply_draft` 说明没有把对象卡教给改画布的模型。

- **Suggestion**:
  - 放弃：「放弃后还没发布的改动会全部没掉，包括动作和字段。确定放弃？」
  - 保存撞 `rev`：「外面已经改过这份草稿，还要按表单里的来？」
  - Esc / 切对象 / 对象被删：「表单里还有没保存的改动，要丢掉吗？」
  - ③ 取值来源选项：「请求里来的」「执行时点名用的值」「写死一个值」。控件栏不要出现 `{ from: identity }`、不要「识别值」。
  - 效应种类：③「新建一个对象」、④「撤走这个对象」。列表按钮保持「删除」。
  - Overview 改成「新建/编辑/删除简单动作」；摘要示例跟 §6 表走「撤走」。KD 15 的「含删除」改成「含撤走」。
  - 规则 3 首句「补三处」改「补四处」。把「认人必须写明」从 `actionSchema` 那句拿开，只留在 ④。PR 3 测试加一条缺认人。Risks / Security「三项」改四处。
  - `formCompatible` 的 `create`：必须有 `object`；属性名非派生源列（与 `update` 对齐）。
- **Status**: open（不挡 approve）

---

### 未再开的攻击（已核对，不成立）

- **请求形状写进定义。** `run_action` 入参仍是 `{ action, object, identity, request? }`。`set_action.def` 仍是附录 B 的 `ActionDef`。`propose_action` 返回即 `set_action.def`。没有 `$root`，动作上没有 `write` 名单。
- **表单把 `filter` 认其他个体、跨类 `update`、`$exists`、`$request`、`now` 系、`{ from: generated }` 收进来。** 白名单没有这些。演示五条为假。
- **`link` 被写成带另一端或带认人键。** Goal 1 与字段表 ②：值为关系名，没有另一端。
- **`apply_draft` 把对象卡能力或「见 Goal 1」写进 `tools/list`。** 已删除。`ontos-canvas` 红线仍是：写动作归 `ontos-action`。Skill 不是沙箱，工具说明列 `set_action` 是全量暴露，不是把表单教给模型。
- **Goal 1 宣称表单能写验收入库 / 调拨 / 登记 / 结束维修 / 带阶段前置的报废。** 明确超出子集。报废超出是因为前置读派生阶段，不是因为改 `mark`——无前置的「把 mark 写成 scrapped」仍在子集里，这与附录 B 报废那条不是同一条动作。
- **④ 会拦 `filter` 认其他个体。** ④ 是二选一不许都缺，不是只许 `identity`。`finish_repair` 那种 `object` + `filter` 仍合法；表单认不出、无「编辑」，只许删。
- **左/右讲对照、芯片「覆盖」、列表按钮「改」。** 没有。
