## Design Document Review: 外部 Agent 编辑画布

### Summary
Verdict: **needs revision**

对象/字段/关系的 MCP 写入、`space` 缺省已发布、`rev` 短轮询、关卡不做写工具——这条线能立。把 `set_action` / `remove_action` 做成「画布不加编辑器、人只点发布」之后，文档内部的「与画布等价」「转化动作由裁决独占」「画布是监视器」「无阻断产品问题」互相打架；发布关卡对动作变成橡皮图章。先拍板动作写路径的产品形态，再开 PR。

---

### Issue 1: 「与画布等价的逐步编辑」与「画布无动作编辑器 + 三则新 op」互相否定
- **Severity**: critical
- **Section**: Goals §1；Non-Goals「为画布加动作编辑器」；Overview；§2 / §2.2；§5 表；Key Decisions 1、3、13
- **Description**: Goal 1 原文：「外部 Agent 能对**当前工作空间**的工作副本做与画布等价的逐步编辑（同一套 `draftOpSchema`）。」Overview 把同一句话收成卖点：「给 MCP 增加与 `draftOpSchema` **同一套**编辑语言的写入工具 `apply_draft`」。

  同文档立刻扩了画布**没有**、也**不打算做**的三条 op：

  - Non-Goals：「为画布加动作编辑器。动作的创建/修改/删除由 Agent 经 `apply_draft` 的 `set_action` / `remove_action` 完成，人只把关发布。」
  - Goal 3：「动作定义由 Agent 生成，人在画布上不需要动作编辑入口。」
  - §5：`replace_object` / `set_action` / `remove_action` 均为「`POST /api/draft` 可用，**UI 无按钮**」。

  「同一套语言」在这里被偷换成「MCP 与 REST 共用 `applyOp`」。那是实现同骨架，不是与画布等价。画布能做的：建删对象、增删字段、设识别字段、建删 `match` 边、导入、摆位。MCP 拿掉摆位、加上整类替换和动作写入。两端的能力集既不是子集也不是超集的干净关系，而是**两条不同的编辑器**共用一个判别联合。

  用「与画布等价」为 `apply_draft` 一次吃下全部 `draftOpSchema` 辩护，再把三个画布没有的 op 塞进这套语言，后半句把前半句证伪了。
- **Suggestion**: 二选一，写进 Goals / Key Decisions，全文用同一句：

  1. **MCP 只暴露画布已有的对象/字段/`match` 边/导入**（可另附带锁定的 `replace_object`）。`set_action` / `remove_action` 从本期拿掉，`propose_action` 继续只建议。这才是「与画布等价」。
  2. **承认 MCP 是画布的超集**：Goal 1 改成「对象/字段/关系与画布同权；动作定义只走 MCP，画布不提供对等编辑」。后面所有「等价」「同权」按这个口径改，不要再写「同一套编辑语言所以能力相同」。
- **Status**: open

---

### Issue 2: 「转化动作由裁决独占」与「覆盖既有动作与画布编辑同权」互相否定
- **Severity**: major
- **Section**: §2.2 规则 4 与规则 5；Key Decision 13；§13 `ontos-action` 红线；§14 逃生路径
- **Description**: 规则 4：「**转化动作仍由裁决独占**，且与转化关系成对约束。」`ontos-action` 红线同一句。Key Decision 13：「转化动作仍由裁决生成并与转化关系成对约束。」

  紧接着规则 5：「**覆盖既有动作与画布编辑同权。** 覆盖种子配置的动作（demo 里的 `convert` 验收入库）或**裁决生成的转化动作都允许**。」

  引擎实际保证的只有两件，而且都不是「动作由裁决独占」：

  1. `create_link` 不收 `transition`（转化**关系**仍只有裁决能造）——这一点成立。
  2. 每条 `transition` 至少被一条动作的效应 `link` 引用；`set_action` 写的效应 `link` 必须指向已有转化关系。

  成对约束不规定：动作名必须是裁决生成的 `convert_to_*`；`pre` 必须仍是「当前阶段 ∧ `$link: false`」；效应必须**只有**那一条 `link`。文档自己写的逃生路径就是：先 `set_action` 一条同样 `link` 该关系的**替代动作**，再 `remove_action` 删旧的。替代动作可以附带 `update` / `delete` / `create` / `inform`。种子动作 `convert` 的效应本就是 `link: converted` **加上** `create: warranty_card`——同名覆盖只要保留那条 `link`，就可以拿掉 `status: in_transit`、拿掉「尚未转化」的 `$link`，或再挂一条 `delete`。

  「独占」若只指关系，规则 4、红线、Key Decision 13 都写错了主语（独占的是关系，不是动作）。「独占」若指动作，规则 5 和逃生路径把它否了。
- **Suggestion**: 全文改成「**转化关系由裁决独占**；转化动作的名字和函数体不独占」。引擎若还要保护裁决产物，必须另加一条真正的锁：例如名字匹配 `convert_to_*` 的动作禁止 `set_action` 覆盖、禁止改 `pre`、禁止在同一动作上追加非 `link` 效应。做不到就删掉所有「转化动作由裁决独占」，skill 不要再拿这句当红线。
- **Status**: open

---

### Issue 3: `set_action` + 无动作编辑器 + 人看不见函数体，把发布关卡收成橡皮图章
- **Severity**: critical
- **Section**: Goal 3；Non-Goals；§5「人只把关发布」；§6 监视器；§12 不建 `log_draft`；Open Questions 第一条；AGENTS.md 关卡；MVP §9「模型只产草稿，人裁决、发布」
- **Description**: 原任务边界是：外部 Agent 改画布工作副本上的**对象 / 字段 / 连线**；循环在外；**发布、裁决仍是人的关卡**。本设计把边界扩成：动作定义的创建/修改/删除由 Agent 完成，画布不加编辑器。

  人在画布上对动作实际能看见的：

  - 节点底部一枚**动作名**标签（`Object.keys(t.actions)`）。同名覆盖时标签不变。
  - 对象编辑卡只有描述、识别字段、字段、来源、危险区——**没有动作区**，没有 `pre` / `effect` / `inform`。
  - 发布按钮的 `title` 只列出**将删除的类**。动作新增、覆盖、删减不出现。
  - 验收问题集核对的是问数，不是动作函数体。

  人看不见的，正是发布后 `run_action` 会拿去改源库的那一份：前置是否被掏空、效应是否多挂了 `delete`、`inform` 发去哪。文档把审查交给「外部 Agent 的对话抄本」（§12、Risks 表「内容变化不可见」行）。那是 **Ontos 之外**的表面。与 Overview「画布仍是唯一工作台」、AGENTS.md「本体构建是唯一页面」直接冲突：动作这条写路径的工作台不在画布上。

  MVP §9：「模型只产草稿（对象、关系、**动作定义**），**人裁决、发布**。」本设计让模型（外部 Agent）把动作定义写进草稿，人只点发布。发布若看不见函数体，就不是裁决，是盖章。Goal 3 把这个扩权写成目标，Open Questions 又把唯一能补上审查面的「画布动作编辑 UI」标成「已拍板、不挡本期」。三句话不能同时真。
- **Suggestion**: 必须先做产品决定，三选一，写进 Goals / Non-Goals / Open Questions，禁止并存：

  **A. 缩回原边界。** 本期 MCP 只写对象/字段/`match`/导入（+ 锁定的 `replace_object`）。不增加 `set_action` / `remove_action`。`propose_action` 维持建议。动作落地等画布有审查面再做。

  **B. 发布要审动作，就给最低审查面。** 对象卡只读列出动作名 + `description` + `pre` + 效应摘要（不必做成编辑器）；发布按钮 `title` / 确认句列出「将新增/覆盖/删除的动作」。人仍不能在画布上改动作，但关卡不是盲签。

  **C. 明确改产品：动作内容不由画布审查。** 删掉「人只把关发布」里暗示的内容审查；写明「人点发布是把 Agent 已写入的动作送进已发布快照，审查面是外部对话抄本」。同时改 AGENTS.md / MVP §9 的「人裁决动作定义」。不要再把画布叫这条路径的监视器。

  现在的文本是 A 的关卡修辞 + C 的能力 + 把 B 推迟，所以发布是橡皮图章。
- **Status**: open

---

### Issue 4: 只改动作定义时，监视器是空壳——toast 无对象差集，节点无可见变化
- **Severity**: major
- **Section**: Goal 4；§6 Toast 文案；§6 点 6–8；Risks「画布节点只显示动作名、内容变化不可见」；Observability「画布 toast 是人能看见的唯一站内信号」
- **Description**: Goal 4：「开着的画布在 Agent 写入后于约 2 秒内显示新草稿，并给一句白话 toast。」§6 把 toast 的差集定义成「本页上次 `ont.object_types` 的**键**与新 JSON 做差集」：

  > 默认（对象集合没变，只改了字段/关系/描述）：「草稿有更新，已刷新」

  括号里的清单是字段/关系/描述，**没有动作**。`set_action` 同名覆盖、`remove_action` 之后又用同名写回、改 `pre` / `effect` 而不改动作名：对象键集合不变 → 默认 toast。节点标签仍是同一个动作名。对象卡没有动作区，开着也不会重绘函数体。§6 点 6 只处理「类被删则收卡」；点 7 只处理描述框；点 8 只处理坐标与 `fitView`。

  文档自己把这行风险标「低」，缓解是：草稿可放弃、发布前不生效、skill 要求覆盖前读回、内容审查靠外部抄本。这四条没有一条让**开着的画布**显示发生了什么。Observability 又写「画布 toast 是人能看见的唯一站内信号」——动作路径上这条信号的信息量是零（已脏的草稿上连「待发布」都不会新出现）。

  更窄的洞：Agent 在一个轮询周期内（≤2s）先 `delete_object` 再 `import_objects` 同名。两次写入之后对象键集合与上一帧相同，人看到的也是默认 toast，节点不必先消失再出现。监视器按键差集设计，对「删了又建」和「只改动作体」同样瞎。
- **Suggestion**: 与 Issue 3 的产品决定绑定。若动作仍走 MCP：toast 至少要能说「动作有更新（equipment.convert）」——差集应对 `actions` 的键，同名覆盖要对 `sameConfig` 后的该类 `actions` 条目；节点上同名覆盖至少把该类打成「待发布」（已发布类本来会，但 toast 仍应点名）。若坚持「对象键差集够用」，Goal 4 和「画布当监视器」必须改成「只监视对象的增删」。现在是承诺监视草稿，实现监视对象名集合。
- **Status**: open

---

### Issue 5: `replace_object` 锁定只看现有类、不看写入体；`import_objects` 可携带 `actions` / `derived`；删了再导入引擎放行
- **Severity**: critical
- **Section**: §2 锁定规则；§2「引擎不闭合先删再导入」；§2.2 末「`add_property` 仍然没有 `derived`」；§5；§13 `ontos-canvas` 红线 vs `ontos-action`「新类可经 `import_objects` 携带 `actions`」；§14 `replace_object` 示意
- **Description**: 锁定表的宣传是：含动作 / 派生 / 多源 / 已发布 / 未对照字段的类不能整份替换。实现口径（§14）是 `replaceBlockers(cur, publishedHas)`，**只读现有类 `cur`**，然后 `d.object_types[name] = input.def`。`def` 的 schema 是完整 `objectTypeSchema`，含 `actions` / `derived` / `axioms` / 多条 `sources`。

  因此未锁定类（刚 `propose_ontology` 出来、或人「新建对象」的空类）可以一次 `replace_object` 写入：动作、派生字段、第二条来源、未对照字段。这些正是锁定表禁止**被盖掉**的东西，却不是禁止**被写进去**的东西。「含动作的类不能整份替换」只在动作已经存在之后生效。`ontos-canvas` 的落地分支明确走「`replaceable === true` → `replace_object`，`def` 取 `propose_ontology.object_types[name]`」；`propose_ontology` 的槽位 schema 就是 `objectTypeSchema`，模型可以在建议里带上 `actions`。引擎没有剥离步骤。

  第二条路：`import_objects` 对**新类名**整份收 `objectTypeSchema`。`ontos-canvas` 红线：「写动作归 `ontos-action`……不用 `set_action` / `remove_action`。」同节 `ontos-action`：「写动作只走 `set_action` / `remove_action`（**新类可经 `import_objects` 携带 `actions`**）。」——动作写入被画在两个 skill 上，引擎对 `import_objects` 不限。canvas skill 按文档允许的 op 就能带动作进来，不必调用被禁止的 `set_action`。

  第三条路：文档坦白「引擎不闭合先删再导入」「锁定只挂在 `replace_object` 上」，skill 红线禁止、人闸仍在。人闸在 Issue 3/4 下对动作函数体是盲的；2 秒内删+导对象键差集还可以是空的（Issue 4）。这条「故意与画布删了再生成对齐」的路，在 MCP 上的效果是：**已发布锁定、含动作锁定、逐步改动作的分工，全部可绕。**

  `add_property` 不收 `derived`、转化关系不让 `create_link` 写——这两道闸是真的。派生仍可通过 `import_objects` / `replace_object` 的完整类体进草稿（§2.2 自己写了）。阶段结构不能单靠 Agent 凑齐（缺 `transition`），但动作和派生可以。
- **Suggestion**:

  1. `replace_object.def` 与 `import_objects` 的类体若继续用 `objectTypeSchema`，锁定必须**对写入体也跑一遍意图检查**：未走 `set_action` 的路径不允许 `def.actions` 非空；若派生只许来自裁决，写入体带 `derived` 应拒（或显式宣布「派生允许经导入进入新类」并改 §2.2）。
  2. 更干净：MCP 的 `import_objects` / `replace_object` 用剥掉 `actions` / `axioms` 的 schema；动作只走 `set_action`。这样 canvas / action 两个 skill 的分工才有引擎形状，而不是红线作文。
  3. 「删已发布类再导入」若坚持与画布对齐，监视器必须把「已发布类被删后同名重建」从默认 toast 里捞出来（例如对照已发布快照：同名类 `sameConfig` 失败且中间经历过缺席）。只靠 skill 红线等于没锁。
- **Status**: open

---

### Issue 6: 语义合法但业务有毒的动作，发布前没有审查主体；`discard` 连坐
- **Severity**: major
- **Section**: §2.2 规则 3（Zod + `validateSemantics`）；§12 不建 `log_draft`；Non-Goals；§5 `delete_object` 与放弃；Key Decision 9
- **Description**: 规则 3 把「写错」定义成：引用不存在的类/属性/关系、写派生、`from` 不在白名单、效应 `link` 不是转化关系、孤儿转化。这些是**形状和指称**。过闸的例子：

  - `set_action convert`，保留 `link: converted`，删掉 `pre.status: in_transit`（在途才能验收变成任意状态都能验收）。
  - 在 `transfer` 的效应上追加 `delete: { object: department, identity: { from: request } }`（调拨顺带删部门）。
  - 把 `scrap` 的 `mark: scrapped` 改成更新另一条源列属性。

  指称都合法，发布后 `run_action` 按效应投影源库。谁在发布前拦住？

  | 角色 | 文档给的能力 |
  |---|---|
  | 引擎 | 不管业务毒性 |
  | 画布上的人 | 看不见函数体（Issue 3/4） |
  | `log_draft` | 明确不建（Key Decision 9） |
  | 放弃 | **整份**丢掉未发布改动，人自己改的字段/对象一并没 |
  | skill | 「覆盖前先读回」——约束的是写的 Agent，不是审的人 |

  人若隐约觉得不对，选项只有：全部放弃（连坐自己的编辑），或全部发布（盖章）。没有「只撤这一条动作」，没有「只撤 MCP 写入」。§12 拒绝 `log_draft` 的理由是「没人读的 UI、与放弃打架」。没有流水的代价是：人问「为什么 convert 变了」时，站内四条路径（节点标签、发布条、外部抄本、MCP 返回的 `{ op, names }`）里，前两条不包含动作体，`names` 对 `set_action` 只给**类名**不给动作名，只剩外部抄本。
- **Suggestion**: 与 Issue 3 同一次产品决定。若走审查面（3-B）：对象卡只读动作 + 发布条点名动作差集，可以继续不建 `log_draft`。若走「抄本即审查」（3-C）：`apply_draft` 返回的 `names` 对 `set_action` / `remove_action` 必须带动作名；toast 用它；放弃语义维持整份，但要在 UI 上写清「放弃会连 Agent 写的动作和你改的字段一起没」。若维持现状（看不见、没流水、放弃连坐），不要写「机器可读由 Zod + validateSemantics 保证」好像毒性也被闸住了——那两道闸保证的是能跑，不是该跑。
- **Status**: open

---

### Issue 7: 「世界 × 读写」四格是口号；`tools/list` 全量九工具让四个 skill 互相看得见
- **Severity**: major
- **Section**: Goal 6；Non-Goals「按 skill 裁剪」；§13 分工表与「四格一格一个」；Alternatives H；PR 4 删除 `skills/ontos/SKILL.md`
- **Description**: §13：「能力矩阵是「世界（已发布 / 草稿）× 方向（读 / 写）」四格，**一格一个 skill**，意图与触发词互不重叠。」数一下实际四份：

  | skill | 真实格子 |
  |---|---|
  | `ontos-query` | 已发布 · 读 |
  | `ontos-action-run` | 已发布 · 写源库（还要读，靠「最小查询子集」） |
  | `ontos-canvas` | 草稿 · 读 + 写对象 |
  | `ontos-action` | 草稿 · 写动作（也读草稿） |

  这不是 2×2。草稿读没有独立 skill；草稿写被劈成两个；已发布写的是源库个体，与草稿写动作不是同一「写」。口号用来论证「必须拆四份」，格子对不上。

  更硬的事实：Non-Goals「按 skill 裁剪 MCP 工具列表。`tools/list` 从 PR 2 起是**全量九个工具**……分工由 skill 文档承担。」MCP 客户端（Claude Code / Codex）加载哪个 skill 与 `tools/list` 无关。问数 Agent 仍会看见 `apply_draft`、`set_action` 所在的判别联合、`list_tables`。四个「互相看不见的世界」只存在于四份 markdown 里。文档把发布/裁决做成「没有这些工具」（引擎真的没有），把「不要 `set_action` / 不要 `space=draft` / 不要删了再导入」做成红线（引擎全有）。红线与关卡被写成同一级克制，只有关卡是真的。

  拆分还切断今天**一份** `skills/ontos/SKILL.md` 的剧本二（先 `query` 核对前置，再 `run_action`，再 `query` 复查）。那条路径合法且是产品演示。拆开后：只加载 `ontos-query` 不许 `run_action`；只加载 `ontos-action-run` 不给完整查询语法；两份都加载则红线互斥（一份「不调用 `run_action`」，一份「调用 `run_action`」）。PR 4 删除旧目录、不留跳板。已经指向 `skills/ontos/` 的客户端会断。
- **Suggestion**:

  1. 删掉「四格一格一个」。改成实话：「四个任务包，同一端点，工具全量可见；skill 是提示不是沙箱。」
  2. 若世界隔离是硬需求：按 `tools/list` 裁剪（例如请求头 / initialize 的 client info），或拆端点。Non-Goals 禁止裁剪就不能同时卖隔离。
  3. `run_action` 与问数的关系单独拍板：保留一份「查数 + 执行已发布动作」skill（今天的 `ontos`），另外只拆 `ontos-canvas`；或在 `ontos-action-run` 里**完整**引用查询工具并允许加载 query skill，不要发明第三份语法还写进「工具」列。
  4. 删除 `skills/ontos/` 时留一份跳转：旧路径写「已拆成四份 / 查数+执行请用 …」，避免调用方空引用。
- **Status**: open

---

### Issue 8: 「最小查询子集」是第二套查询语言；skill 红线引擎不执行
- **Severity**: major
- **Section**: §13 `ontos-action-run` 工具列与「最小查询子集」；Goal 6；§2 / §5 / §13 各条「引擎不拦、靠红线」
- **Description**: 分工表工具列：`run_action` + **最小查询子集**。子集不是 MCP 工具，是 skill 里另写的一份 `query` JSON 方言（identity、按属性过滤、`$link` 存在性；不写 `aggregate` / `expand` / 排序）。真正执行它的仍是全量 `query` 工具，引擎按完整语法收。于是：

  - 执行动作的 Agent 被教一套较窄的查询语言，工具本身接受更宽的；
  - 查数 skill 另有一份完整语法；
  - 两份文档会各自漂移（日期表达式、`$link` 嵌套层、`limit` 默认），引擎只认一份。

  「最小」还写在**工具**列，像有一个叫最小查询的工具。Agent 可能把那三段 JSON 塞进 `run_action`，或臆造 `query_lite`。

  同一模式在锁定和分工上重复：`delete_object`+`import_objects`、canvas 不用 `set_action`、`base_rev` 可选但 skill 要求必带、sourceless 类上人加过字段不要 `replace_object`。Overview / 不可协商把「人的关卡不做写工具」写成引擎事实（成立），把「Agent 不得绕过已发布锁定」写成与关卡并列的克制（不成立）。Key Decision 3 已承认「`delete_object` + `import_objects` 引擎放行，skill 禁止」。在 `tools/list` 全量暴露的前提下，把产品安全放在 skill 红线上，等于放在模型是否听话上。这与 MVP §9「循环的中间产物没人读，裁决权也就丢了」同一类失败：红线是中间产物，引擎不读它。
- **Suggestion**: `ontos-action-run` 工具列只写真实工具名 `run_action`、`read_class`、`query`。查询语法要么「本 skill 不重复、去读 ontos-query」——那就不能强调自包含；要么自包含就抄完整查询节，不要维护子集。`base_rev` 若是改画布的纪律，MCP 侧对 `apply_draft` 改为必填，或 canvas skill 的 `inputSchema` 描述里写成 required（现在信封是 `optional`，省略则后写赢）。引擎不执行的红线不得写成与「无发布工具」同级的安全措施；能绕的锁要么闭合，要么从锁定表拿掉以免假装有锁。
- **Status**: open

---

### Issue 9: Open Questions 写「无阻断产品问题」不诚实
- **Severity**: major
- **Section**: Open Questions 全文；Goal 3；Non-Goals 动作编辑器；Risks「内容变化不可见」标低；§2.2 规则 6 `outlets`
- **Description**: 原文：「**无阻断产品问题。** 下列为已拍板的后续，不挡本期 PR：」第一条就是「画布动作编辑 UI：本期不做。动作的创建/修改/删除由 Agent 经 `set_action` / `remove_action` 完成，人只把关发布。」

  这一条不是后续优化，是 Issue 3 的产品空洞本身。文档在 Risks 里已经看见「节点只显示动作名、内容变化不可见」，却标「低」，缓解指向放弃和外部抄本。然后在 Open Questions 把「要不要给人看」判成已拍板不挡 PR。这不是把未决项收口，是把未决项改名为已决、把阻塞改名为后续。

  另外两条也不像「无阻断」：

  - `outlets` 无写入 op：新工作空间写不出带 `inform` 的合法动作。若 `ontos-action` 要把告知写成可落地能力，这是能力缺口；若告知仍按附录 A「本期不交付」，应在 skill 里写「不要写 `inform`」，而不是让 Agent 去 `list_classes` 找一张新空间里必空的名单。
  - `list_candidates` / `overlap` 不做：跨源 `import_objects` 之后 Agent 只能口头请人点「疑似重复」。与「选表不是缺口」同一修辞——能力已经从 MCP 进去了，关卡只留在画布按钮上。

  「已拍板的后续」可以存在。不能在同一节写「无阻断产品问题」，而阻断项就是本节第一条。
- **Suggestion**: Open Questions 改成至少两个未拍板项，挡 PR 2 的动作 op：

  1. 动作写路径选 Issue 3 的 A / B / C。未选之前 `set_action` / `remove_action` 不进 `draftOpSchema`。
  2. `import_objects` / `replace_object` 是否允许携带 `actions` / `derived`（Issue 5）。未选之前不要写「写动作只走 `set_action`」。

  `outlets`、候选对只读工具可以留作真·后续。
- **Status**: open

---

### Issue 10: 「选表 / 生成对象仍是人的关卡」与 `list_tables` + `import_objects` 同时成立，只能有一句是真的
- **Severity**: major
- **Section**: 不可协商；§4 末段「这不是选表关卡的缺口」；§5 表「勾表并生成对象 / 禁止」；Goal 1；AGENTS.md「人的点击只留给关卡——选表、确认、裁决、发布」
- **Description**: 不可协商：「人的关卡：发布、放弃、裁决、回滚、连接数据源、**画布上勾表并点「生成对象」**。这些不做 MCP 写工具。」§5：`POST /api/generate` 禁止做成 MCP。§4：「这不是「选表关卡」的缺口。……Agent 点名表、先 `propose_ontology` 再自己决定是否 `import_objects`，循环在外面——这是 §9 第二条入口的补全，不是把画布按钮搬进 MCP。」

  人关卡若指**按钮**，这句话是真的：MCP 没有 `generate`。人关卡若指 **「哪些表变成画布上的对象」这个决定权**，这句话是假的：`list_tables`（无采样，但有表名列名）+ `propose_ontology` + `import_objects` 就是选表并生成对象，只是拆成三步、循环在外。AGENTS.md 的关卡是「选表」，不是「点那个叫生成对象的按钮」。

  MVP §9「入口两个」确实给了外部 Agent `propose_ontology`。今天建议不落地，选表关卡事实上还在人手里。本设计把落地补上，却仍把「勾表并生成对象」列在不可协商的人关卡里，靠「我们没把那个按钮叫 generate 暴露出去」过关。这是关卡修辞，不是关卡。

  与 Issue 3 同构：发布按钮还在人手里，所以叫人的关卡；动作内容人看不见。选表按钮还在人手里，所以叫人的关卡；Agent 已经能把表变成对象。
- **Suggestion**: 不可协商改成真正仍由人独占的决定：**连接的保存/删除、裁决、发布/放弃/回滚、摆位、以及「生成对象」这一次性槽位+导入的画布按钮**。另写一句产品事实：「外部 Agent 经 `list_tables` → `propose_ontology` → `import_objects` 可以把表建成对象，不经过画布勾选。这是 §9 第二条入口，选表关卡只约束画布那条入口。」不要写「这不是缺口」。若产品仍要求选表必须经过人，就不要给 `import_objects`，只给逐步 `create_object` / `add_property`（人先勾表生成，Agent 再改）。
- **Status**: open

---

### Issue 11: 四 skill 自称自含语法，PR 4 没把动作定义骨架写进 `ontos-action`
- **Severity**: major
- **Section**: §13「各自自包含（端点、信封、错误码、鉴权、语法、红线都写全）」；§13 `ontos-action` 四步；§2.2 规则 1「或按动作骨架拼的等价形状」；PR 4 影响文件
- **Description**: `propose_action` 在类上**已有**转化关系时只返回 `conversionAction` 模板（§3、现 MCP 路由同一口径）。设备类这种已有 `converted` 的对象，要新增 `transfer` 这类改属性动作，不能靠 `propose_action`——必须「按动作骨架拼」。§2.2 规则 1 把这条列为 `def` 的第三来源。

  自包含承诺包含「语法」。PR 4 给 `ontos-action/SKILL.md` 列的内容是：工具表、四步方法论、红线（转化独占、`inform` 查 outlets、覆盖先读回、逃生路径、不发布）。**没有**附录 B 的动作定义骨架（`pre` / `effect` 的 `update|create|delete|link` / `inform` / `generate` 列表 / 禁止 `$root` 与 `write` 名单）。今天的 `skills/ontos/SKILL.md` 只有**执行**动作的 `{ action, object, identity, request }`，也没有定义侧语法。拆分时从旧 skill 迁不来这份骨架。

  结果：号称自包含的写动作 skill，在最常见的「给已有转化的类再加一条业务动作」路径上，让模型现场发明 YAML。引擎会挡一部分（`$root`、不存在的属性），挡不住 Issue 6 那种有毒但合法的效应。这不是实现遗漏，是 PR 4 说明书漏了它自己的「语法」列。
- **Suggestion**: PR 4 的 `ontos-action` 必须内嵌一份与附录 B 同构的动作定义骨架（可抄文章，但要在 skill 里，因为「不建公共文件、Agent 往往只加载一个 skill」）。并写明：类上已有转化关系时 `propose_action` **不会**给改属性模板，必须按骨架拼。若不愿在 skill 里复制附录 B，就不要写自包含，改成「定义动作前必须能读到 `ontos-article` 附录 B」——外部 Agent 通常读不到那篇。
- **Status**: open

---

### Issue 12: PR 4 把「请到画布上看」和 README「画布轮询显示」写成已有能力，依赖却是建议
- **Severity**: major
- **Section**: PR Plan PR 4 依赖/说明；§13 `ontos-canvas` / `ontos-action` 第四步；README 变更句；Goal 4
- **Description**: PR 4「**依赖：PR 2**（工具已存在）。**建议**等 PR 3 合入后再合本文，这样『画布会自己刷新』不是谎。」同一 PR 的 README：「建模流补一句『外部 Agent 经 `apply_draft` 写工作副本，**画布轮询显示**』。」

  依赖图里轮询是建议，对外句子里轮询是事实。合入顺序若按硬依赖（4 只等 2），skill 与 README 早于监视器。文档自己知道这是谎，仍把「避免文档早于工具」写成 Rollout 第 4 步的理由，却不把 PR 3 写成 PR 4 的硬依赖。

  即使等 PR 3：`ontos-action` 第四步仍是「告诉人『草稿已改，**请到画布上看**；生效请在画布上点发布』」。画布上看不见动作函数体（Issue 3/4）。这句在监视器落地之后仍然是半句真话——人能看见节点可能打了「待发布」，看不见改了什么动作。canvas skill 对对象增删勉强成立；action skill 复制同一句收口，把动作路径也指向一个没有动作表面的屏幕。
- **Suggestion**: PR 4 硬依赖 PR 3，或 README / skill 在 PR 3 未合前不得写「画布轮询 / 会自己刷新」。`ontos-action` 的收口句改成与画布真实可见物一致：例如「草稿已脏，请到画布上看该类是否标了待发布；动作内容请在这边对话里核对，画布不展示前置和效应」。不要用「请到画布上看」暗示画布能完成动作审查。
- **Status**: open

---

### Issue 13: 工具说明里「有人对不上表列的字段」主语挂错；「出站」未登记却进了 Agent 可见文案
- **Severity**: minor
- **Section**: §1 `apply_draft` / `list_classes` description；§2 锁定白话表；§13「工具说明与 skill 正文用大白话」；AGENTS.md 语言规则 / 术语表
- **Description**: AGENTS.md：用户界面和 **Agent 对话**一律大白话；新造词先登记；下笔前问「这个谓语能说谁」。`tools/list` 的 description 是 Agent 可见文案。

  `apply_draft` 说明：「整份替换一个还没发布、也没有派生字段/动作/多来源的对象（**已挂来源的类上若有人对不上表列的字段**，也不能整份换）。」「对不上」的主语写成「人」。人对不上的不是表列；是**字段没有对照到表上的列**。同节锁定表自己的白话是「含有未对照到表列的字段」，工具说明换了一种就把主语挂到人身上。

  `list_classes` 说明：「返回里带 `outlets` **出站名**列表。」「出站」不在 AGENTS.md 术语表，也不是行业公认词。告知在附录 A 还是「已设计，本期不交付」。Agent 第一次看见「出站」没有白话注解。§13 允许 skill 出现工具名，没有允许把未登记领域词塞进 `tools/list`。

  对照：本文新 toast 没有用左/右说映射，也没有把「工作副本」写进 toast，这一段是干净的。问题在工具说明，不在 toast。
- **Suggestion**: `apply_draft` 括号改成与锁定表同一句：「已挂来源、且有字段没对照到表上的列，也不能整份换」。`outlets` 在 description 里写成「告知要发去的系统名（配置里的 outlets）」或 skill 内第一句注解；不单独甩「出站名」。
- **Status**: open

---

### Issue 14: 信封 `passthrough` 再整包交给 op schema，`base_rev` 是否被当未知键拒绝，未写剥离
- **Severity**: nit
- **Section**: §1 入参校验顺序；§14 MCP 伪代码 `applyDraftEnvelope.parse` → `mcpDraftOpSchema.parse(env)`
- **Description**: 信封是 `z.object({ base_rev: ….optional() }).passthrough()`，然后 `mcpDraftOpSchema.parse(env)`。`env` 仍带 `base_rev`。Zod 对象默认 strip 未知键时能过；若 MCP 用的 `toJSONSchema` / 判别联合在 Zod 4 下对未知键失败，所有带 `base_rev` 的合法调用都会 `-32602`。文档写「禁止手拆字段」，没写「parse op 之前删掉 `base_rev`」。这是实现时必踩的一叉，不是产品问题。
- **Suggestion**: 伪代码写成 `const { base_rev, ...rest } = env; const op = mcpDraftOpSchema.parse(rest)`，或给每个 op variant 显式 `.strip()`。测试已钉 `base_rev` 字符串失败、数字冲突失败，再加一条：合法数字 `base_rev` + `add_property` 必须 200 / `ok: true`。
- **Status**: open

---

### Strengths
- **发现缺省已发布、非法 `space` 与「不接受 space 的工具带了 space」一律 `-32602`**，拒绝把 `query` / `run_action` 默默切到草稿。这是 Overview 要修的盖写问题的正确闸，Alternatives C 的取舍清楚。
- **一个 `apply_draft` + 与 REST 同判别联合、一次一条 op、循环在外**，符合「Ontos 一次调用一次结果、不把 ReAct 做进进程」。不发明 `apply_proposal` / `upsert_objects`，槽位只建议，与 MVP §9「模型当顾问」一致。
- **`base_rev` 进 `applyOp` 队列任务开头，路由不比、不套第二层队列**；`enqueue` 用 `then(task, task)` 失败续链。这两条是真并发设计，不是口号。
- **`rev` 挂在 `Store` 上只加不回零、加在校验成功后第一个 await 前、`save_layout` 不加**；304 + `Cache-Control: no-store`；`withLocalWrite` 的 `finally` 放下 `localBusy`（含裁决 `onDone`）。监视器若只服务对象/字段/边，这套够用。
- **发布 / 放弃 / 裁决 / 回滚 / 连源 / `save_layout` / `generate` 不做 MCP 写工具**——这些关卡在工具列表层面是真的没有，不是红线假装没有。
- **`list_tables` 无采样、无密码、不保存连接**；连接关卡仍在画布。数据边界没有被这条发现工具撕开。
- **`replace_object` 不走 `dropClass`、断了的 `match` 靠 `validateSemantics` 整步回退**，比「删了再导入」对人手画的边更安全（在锁定真的罩得住的前提下）。
- **PR 1 只读 `space=draft` + `rev`、发现工具说明点明已发布**，把「改画布的 Agent 仍按已发布改」的回归钉在写工具出现之前。这个切分对。
- 文档把 `DraftReject` → `-32000`、空 `actions: {}` 不能用真值判断、`remove_action` 删空要清键以免 dirty 收不回、`mergeInto` 跳过指向将被删除转化关系的动作，写成了可测试的契约，而不是「实现时注意」。

---

**结论（给修订用的最短路径）**

先停 PR 2 里的 `set_action` / `remove_action`，或先补画布上的动作只读面——这两件事未选其一，Goals / 独占 / 监视器 / 人的关卡 / Open Questions 无法同时成立。对象/字段/`match`/`space=draft`/`rev` 轮询可以按现方案往前走，但不要再写「与画布等价」去覆盖一条画布上不存在的编辑器。
