# Palantir Foundry Ontology 概念对照：Ontos「类间判定」模型的缺口考察

- 研究日期：2026-09-01。**网络可用**，Palantir 官方文档（服务端渲染 HTML）已用 curl 抓取正文核对；无法核对的个别条目已标注「未核对」。
- 触发案例：逆向建模把设备台账（device）与维修工单（repair）召回事宜候选对（两表都有序列号字段），交集率 0%，建议引擎却推出「类等价，合并」。该错已按 CONTEXT.md「判定办法」修掉，本文不重复归因，只回答：剩下的缺口是概念性的还是提示词性的。

## ① 结论摘要

1. Ontos 的类/属性/关系/动作与 Foundry 的 object type / property / link type / action type 一一对应，定义无漂移；Foundry 另有 shared property 与 interface，与 Ontos 的「公共属性 / 上位对象」部分对位。
2. Palantir **没有**「合并两个 object type」「两个对象类型等价裁决」这类运行时概念。类型该不该合并属于设计期重构，由人在 Ontology 设计时审阅；运行时只合并**对象实例**（Gotham 的 object resolution）或经 action 编辑对象。
3. 「两份数据描述同一个体」在 Palantir 分两层解决：数据管道层靠确定性主键构造与唯一性校验；实例层靠 Gotham object resolution（可 resolve / unresolve，留历史）。Foundry 公开文档没有 entity resolution 专页，去重不是本体层的原语。
4. 「两个不同事物类型 + 指向关系」在 Palantir 是本体一等公民（link type，可用外键列、联结表、对象三种落法）；Ontos 的判定菜单确实没有这个出口——同形异义只定「两类都留下」，之后建 match 关系要人手画，没有承接。
5. 本文建议：**不**把「不同类但建链」加进裁决菜单作为新的结论项；把分流做在召回/建议层（事件记录表 vs 主体表），把建链做成同形异义定案后的建议动作。理由见 ⑤。

## ② Palantir 概念集（官方定义与出处）

核心概念页把 Ontology 定义为「对世界的分类」与组织的 digital twin，通过把数据集和模型映射到 object types、properties、link types、action types 拼成全貌（[Core concepts](https://palantir.com/docs/foundry/ontology/core-concepts/)）。

- **object type（对象类型）**：一种现实中的 entity 或 event 的 schema 定义；object 是它的单个实例，object set 是实例集合。原句 "An object type is the schema definition of a real-world entity or event."（[Object types overview](https://palantir.com/docs/foundry/object-link-types/object-types-overview/)）注意定义内嵌 entity/event 二分——工单与设备从概念分层起就是两种 object type。
- **property（属性）**：某 object type 所指 entity/event 的某项特征的 schema 定义（[Properties overview](https://palantir.com/docs/foundry/object-link-types/properties-overview/)）。
- **shared property（共享属性）**：可在多个 object type 上使用的属性，用于跨类型的一致建模与元数据集中管理（[Core concepts](https://palantir.com/docs/foundry/ontology/core-concepts/)）。
- **link type（关系类型）**：两个 object type 之间关系的 schema 定义；link 是该关系在两个对象间的单个实例。要点：关系是双向的，一头一个 object type，各有各的 API 名；同类两个对象之间也可以连（Direct Report ↔ Manager）；同一对类型之间可立多条互相独立的关系；多对多基数时由数据源直接支撑关系本身（[Link types overview](https://palantir.com/docs/foundry/object-link-types/link-types-overview/)）。
- **link 的三种数据落法与基数**：基数有 one-to-one / one-to-many / many-to-one / many-to-many（one-to-one 只是指示、不强制）；落法有 object type 外键列（一对一、多对一）、联结表数据集（多对多）、对象支撑的 link type（object-backed link，可带自己的属性）（[Create a link type](https://palantir.com/docs/foundry/object-link-types/create-link-type/)）。
- **interface type（接口类型）**：描述 object type 的形状与能力、供多类型实现的抽象类型；object type 具体而由数据集支撑、可实例化，interface 抽象、无数据集支撑、不能直接实例化（[Interfaces overview](https://palantir.com/docs/foundry/interfaces/interface-overview/)）。
- **group（组）**：Foundry 本体里与「组」最接近的是 object type groups——帮用户检索和探索本体的分类原语，由 Ontology Manager 管理，**不是**实例集合（[Object type groups](https://palantir.com/docs/foundry/object-link-types/type-groups/)）；实例集合另有 object set（object instances 的集合，[Core concepts](https://palantir.com/docs/foundry/ontology/core-concepts/)）。任务清单里写的「object group」在官方文档中没有作为本体类型出现，按 object type groups 理解（未核对到更早版本的 object group 命名）。
- **action type（动作类型）**：一组对对象、属性值、关系的变更的 schema 定义，一次提交，含副作用；写入沉淀在 object type 的 writeback dataset（[Action types overview](https://palantir.com/docs/foundry/action-types/overview/)、[Core concepts](https://palantir.com/docs/foundry/ontology/core-concepts/)）。

附带一条对本案极有用的官方示例：结构指引要求每条 link type 回答一个领域问题，举例正是 "Which equipment was used in this work order?"（哪台设备用在这张工单上）（[Ontology design: Structural guidance](https://palantir.com/docs/foundry/ontology/ontology-structural-guidance/)）——设备台账 × 维修工单在 Palantir 语境的标准答案就是工单到设备的 link type。

## ③ 实体归一在 Palantir 的位置（答研究问题 2、3、5）

**三层分工：**

1. **数据集成层（Data Connection / pipeline）**：Data Connection 负责把外部系统数据同步进 Foundry（[Data Connection overview](https://palantir.com/docs/foundry/data-connection/overview/)）；去重、归一、构造身份在这一层的管道逻辑里做——官方要求主键「应是确定性的……把主键定义为单列或多列的函数，靠 pipeline 逻辑实现」，并要求在设主键前检查数据源里的重复（[Create an object type](https://palantir.com/docs/foundry/object-link-types/create-object-type/)）。
2. **本体索引层（Object Storage / Funnel）**：同一 object type 可挂多个数据源（column-wise MDO），主键属性必须存在于每个输入数据源以联结各源；索引服务 Funnel 按主键把数据变成对象实例，主键重复会让批管道直接失败（[MDO](https://palantir.com/docs/foundry/object-permissioning/multi-datasource-objects/)、[Indexing overview](https://palantir.com/docs/foundry/object-indexing/overview/)、[Funnel batch pipelines](https://palantir.com/docs/foundry/object-indexing/funnel-batch-pipelines/)、[Create an object type](https://palantir.com/docs/foundry/object-link-types/create-object-type/)）。即：**类型层的归一 = 一个类型挂多源、靠主键对齐；本体层自身不 resolve，只拒绝重复主键**。
3. **实例层（Gotham object resolution）**：官方定义 "Object resolution is the act of combining two or more Objects"——把来自不同源系统、指向同一现实个体的对象合并，防止重复对象产生；合并保留各子对象历史，可 unresolve 回滚，配 canonical/winner 主键元数据与 resolve/unresolve API（[Object resolution basics](https://palantir.com/docs/gotham/api/revdb-resources/resolution/resolution-basics/)；API 端点见 [resolve-objects](https://palantir.com/docs/gotham/api/v1/revdb-resources/resolution/resolve-objects/)）。注意这是 Gotham 的 API 面，不在 Foundry 文档树内。

**resolved entities 解决什么、不解决什么**：解决「不同源的行是否指向同一个体」（实例层身份合并，可回滚）；不解决「两个 object type 是否在描述同一种事物」——后者是建模决策。官方最佳实践把它归为**设计期审阅**：目标是每个概念一个 canonical 表示；若多个对象类型形状相同，应评估它们该合并为一个类型（加区分属性）还是实现同一个 interface，并给出「rule of three」触发线（[Ontology design: Best practices](https://palantir.com/docs/foundry/ontology/ontology-best-practices/)）。此外官方把「把同一实体的历史版本立成多个对象类型」列为反模式（The Time Machine），推荐版本化/时间序列/链接历史等做法（[Ontology design: Anti-patterns](https://palantir.com/docs/foundry/ontology/ontology-anti-patterns/)）。

**答研究问题 3**：不存在「合并两个 object type」或「类型等价裁决」的运行时概念。object type 永远各自独立；同一性只在数据行层面解决（主键、Gotham resolve）；类型之间只谈 link type / shared property / interface。官方文档里的 "merge" 另有所指：Ontology scenario 的合并动作（把场景内暂存的编辑作为一个事务提交），与类型合并无关（[Merge scenarios](https://palantir.com/docs/foundry/ontology/merge-scenario/)）。

**答研究问题 5（相关关键词盘点）**：

| 关键词 | 在 Palantir 语境的所指 | 出处 |
|---|---|---|
| data connection | 同步外部系统数据的接入应用（sources、syncs、agents） | [Data Connection overview](https://palantir.com/docs/foundry/data-connection/overview/) |
| pipeline | 数据管道：Pipeline Builder / Code Repositories 里的变换链，产出的数据集经 Funnel 索引成对象 | [Building pipelines](https://palantir.com/docs/foundry/building-pipelines/overview/)、[Funnel batch pipelines](https://palantir.com/docs/foundry/object-indexing/funnel-batch-pipelines/) |
| primary key（deterministic） | 类型内唯一标识实例的属性；去重与跨源对齐的锚 | [Create an object type](https://palantir.com/docs/foundry/object-link-types/create-object-type/) |
| multi-datasource object type | 一个类型挂多源、靠主键联结（仅 column-wise） | [MDO](https://palantir.com/docs/foundry/object-permissioning/multi-datasource-objects/) |
| object resolution / resolved objects | 实例层合并（Gotham），resolve/unresolve/元数据 API | [Object resolution basics](https://palantir.com/docs/gotham/api/revdb-resources/resolution/resolution-basics/) |
| user edits / writeback dataset | action 写回的对象编辑沉淀数据集 | [How user edits are applied](https://palantir.com/docs/foundry/object-edits/how-edits-applied/)、[Action types overview](https://palantir.com/docs/foundry/action-types/overview/) |
| record matching、golden record、master data、entity resolution（作为应用名） | **未在** Ontology building、Data Connection、Pipeline Builder、building-pipelines 四节导航（各约 1200 个链接）中检出同名页面（2026-09-01 抓取）；Gotham 历史上曾有 Record Matching 应用、Foundry 有以管道实现实体归一的实践（训练知识，未核对）。数据管道文档明确含 CDC 一节，指变更数据捕获，非去重 | [Data Connection 文档树](https://palantir.com/docs/foundry/data-connection/overview/) |

## ④ 与 Ontos 判定模型的逐项对照

判定办法三问（同一种事物 / 同一批个体 / 不同时期）与类间结论各项（类等价、部分重叠、生命周期、同形异义、跳过）的定义以 CONTEXT.md 为准；工程纪律以 AGENTS.md 为准。逐项对照如下。

| 对照点 | Palantir Foundry | Ontos | 判定 |
|---|---|---|---|
| 类型的语义 | object type 定义内嵌 entity or event 二分（[Object types overview](https://palantir.com/docs/foundry/object-link-types/object-types-overview/)） | 类不区分主体/事件，逆向建模按表生成 | **缺口（召回层）**：事件记录表会因字段与主体表相似而入围候选对 |
| 两源同一种事物（类型层） | 一个类型挂多源，主键对齐（[MDO](https://palantir.com/docs/foundry/object-permissioning/multi-datasource-objects/)） | 类等价 → 合并为一个类、多源映射 | 对齐；Ontos 把这一步做成人机裁决是产品差异，非缺口 |
| 两源同一个体（实例层） | pipeline 构造确定性主键；重复主键管道失败（[Create an object type](https://palantir.com/docs/foundry/object-link-types/create-object-type/)）；Gotham resolve 可合并/拆回实例（[Object resolution basics](https://palantir.com/docs/gotham/api/revdb-resources/resolution/resolution-basics/)） | 交集率 + 唯一键（identity）判同一批个体；个体留源库 | 对齐；Ontos 用交集率把「同一批」量化，Foundry 无此原语 |
| 类型合并的定性 | 设计期重构，人审阅，rule of three（[Best practices](https://palantir.com/docs/foundry/ontology/ontology-best-practices/)） | 类等价是运行时裁决项，合并是落地动作 | 对齐精神、机制不同：Ontos 须守住「LLM 只建议、裁决权在人」（AGENTS.md 已立） |
| 不同类型 + 指向 | link type 一等公民：外键列 / 联结表 / object-backed link 三种落法（[Create a link type](https://palantir.com/docs/foundry/object-link-types/create-link-type/)） | match 关系靠配对字段成立，但判定菜单无此出口；定案后建链要人手画 | **缺口（承接层）**：见 ⑤ |
| 无领域含义的连线 | 反模式：仅因两个数据集共享外键就画链是噪音，须验证语义（[Structural guidance](https://palantir.com/docs/foundry/ontology/ontology-structural-guidance/)） | match 靠配对字段即可成立（结构约束） | 风险点：若引擎自动建议建链，须要求领域含义，不能纯字段同形就推 |
| 同一实体的不同时期 | 把历史版本立成多个类型是反模式（The Time Machine），应版本化/时间序列（[Anti-patterns](https://palantir.com/docs/foundry/ontology/ontology-anti-patterns/)） | 生命周期是一等裁决：两阶段合成一个类 + 阶段值域 + 转化动作 | 殊途同归：Ontos 的裁决结果恰好是 Palantir 推荐的「单一规范表示」，不冲突 |
| 跨类型的公共部分 | shared property / interface 承载共性（[Core concepts](https://palantir.com/docs/foundry/ontology/core-concepts/)、[Interfaces overview](https://palantir.com/docs/foundry/interfaces/interface-overview/)） | 部分重叠立上位对象，同名公共属性上移（ADR 0001，AGENTS.md） | 机制不同、目的相同；interface 是无实例抽象，上位对象是可查的类，Ontos 不必照搬 |
| 「组」 | object type groups 仅是检索分类；实例集合叫 object set（[Object type groups](https://palantir.com/docs/foundry/object-link-types/type-groups/)、[Core concepts](https://palantir.com/docs/foundry/ontology/core-concepts/)） | 无对应概念（疑似重复串是工作队列，非本体要素） | 非缺口 |

## ⑤ 对 Ontos 的建议：哪些是概念缺口，哪些只是提示词问题

**只是提示词/召回规则问题的（不算概念缺口）**：「交集率 0% 却建议类等价」已按 CONTEXT.md 判定办法修掉——第一问命中为零不能否定同一种事物，但也不能据此肯定；建议引擎把「字段同形」当成了第一问的证据，属实现错误。同样地，「建议引擎按提示词规则推理」与「模型当顾问不当计算器」（AGENTS.md）一致，问题在提示词而非判定模型本身。

**概念缺口一：召回/建议层缺「事件记录表 vs 主体表」分流。** 论证：Palantir 从类型定义起就把 entity 和 event 并列为 object type 的两种所指（[Object types overview](https://palantir.com/docs/foundry/object-link-types/object-types-overview/)），因此 Employee 与 WorkOrder 在概念上不会成为「疑似同一事物」的比较对象；而 Ontos 的入围只看「结构相似」（CONTEXT.md「入围」「建议」两条：结构比对列出可能有关的对，会漏、会错），两张都有序列号字段的表自然入围。建议在 `proposePairs`（建议原语）阶段加软分流：行数随时间增长、以日期与外部编号为主要字段、自身不充当其他表的身份锚的表，标记为「疑似事件/单据记录」，不再进疑似重复队列，改提示「可能是指向某主体的记录，可在画布上画 match 关系」。这不新增裁决键，不违反「类关系不是封闭清单」（CONTEXT.md），与 Foundry 的 entity/event 二分同构。

**概念缺口二：同形异义（及跳过）定案后「建链」没有承接动作。** 论证：Palantir 把「两个类型之间建立指向」当本体一等公民，且给出了三种数据落法（外键列、联结表、object-backed link）（[Create a link type](https://palantir.com/docs/foundry/object-link-types/create-link-type/)）；Ontos 的 match 关系虽也是配对字段成立，但它是画布上的人手动作，判定菜单、裁决留痕、`class_conclusions` 都不承载它。本案里，设备与工单的正确结局是「两类都留下 + 工单序列号指向设备」，这个结局需要两次人手操作才能完成。建议：同形异义定案后，引擎按「两类存在同名/同语义的标识字段」给出一条建议连线（match 关系草案），人确认后上画布；仍属建议，不改变裁决菜单的既有结论。守门参照 Palantir 的 meaningless-links 反模式：仅当字段在领域上确指同一现实联系时才建议，不能因共享字段名就推（[Structural guidance](https://palantir.com/docs/foundry/ontology/ontology-structural-guidance/)）。

**不建议做的：把「不同类但建链」立为裁决菜单里的新结论项。** 论证：CONTEXT.md 对「判定」的定义是断言三问中的那一项成立，不是类与类关系的全集；「不同类」已由同形异义表达，「有无关系」在 Ontos 里属于个体层的「关系」（CONTEXT.md「关系」条），两者分属不同层。Palantir 的概念划分同样把「类型是否相同」与「类型间有无关系」分开：object type 各自独立，link type 才谈关系（[Link types overview](https://palantir.com/docs/foundry/object-link-types/link-types-overview/)）。把建链塞进裁决菜单会混淆这两层，也违反 AGENTS.md「不为单一场景加专用键」的纪律。同理，「不同库 / 同一库两张表」已覆盖候选对来源，无需为工单场景另开口子。

**顺手对齐的两处（低成本）**：官方「主键应确定性、重复主键报错」与 Ontos「源表 identity 列须唯一索引」（AGENTS.md 写回幂等条）同源，文档可互引；The Time Machine 反模式可作为生命周期裁决的对照注脚写进后续 ADR，说明两类方法论殊途同归。

## ⑥ 引用清单

Palantir 官方文档（均于 2026-09-01 抓取正文核对）：

1. Ontology Core concepts — https://palantir.com/docs/foundry/ontology/core-concepts/
2. Object types overview — https://palantir.com/docs/foundry/object-link-types/object-types-overview/
3. Properties overview — https://palantir.com/docs/foundry/object-link-types/properties-overview/
4. Link types overview — https://palantir.com/docs/foundry/object-link-types/link-types-overview/
5. Create a link type（基数与三种落法）— https://palantir.com/docs/foundry/object-link-types/create-link-type/
6. Interfaces overview — https://palantir.com/docs/foundry/interfaces/interface-overview/
7. Object type groups — https://palantir.com/docs/foundry/object-link-types/type-groups/
8. Action types overview — https://palantir.com/docs/foundry/action-types/overview/
9. Create an object type（主键与重复校验）— https://palantir.com/docs/foundry/object-link-types/create-object-type/
10. Multi-datasource object types — https://palantir.com/docs/foundry/object-permissioning/multi-datasource-objects/
11. Indexing overview（Funnel）— https://palantir.com/docs/foundry/object-indexing/overview/
12. Funnel batch pipelines — https://palantir.com/docs/foundry/object-indexing/funnel-batch-pipelines/
13. How user edits are applied — https://palantir.com/docs/foundry/object-edits/how-edits-applied/
14. Ontology design: Best practices — https://palantir.com/docs/foundry/ontology/ontology-best-practices/
15. Ontology design: Anti-patterns（The Time Machine 等）— https://palantir.com/docs/foundry/ontology/ontology-anti-patterns/
16. Ontology design: Structural guidance（link 领域问题、meaningless links）— https://palantir.com/docs/foundry/ontology/ontology-structural-guidance/
17. Why create an Ontology? — https://palantir.com/docs/foundry/ontology/why-ontology/
18. Merge scenarios — https://palantir.com/docs/foundry/ontology/merge-scenario/
19. Data Connection overview — https://palantir.com/docs/foundry/data-connection/overview/
20. Building pipelines overview — https://palantir.com/docs/foundry/building-pipelines/overview/
21. Gotham API：Object resolution basics — https://palantir.com/docs/gotham/api/revdb-resources/resolution/resolution-basics/
22. Gotham API：resolve-objects — https://palantir.com/docs/gotham/api/v1/revdb-resources/resolution/resolve-objects/

Ontos 内部：AGENTS.md（术语表、入口对照、写与 Agent）；CONTEXT.md（类与类、判定与证据、边界）。

未核对项：Gotham 历史 Record Matching 应用、Foundry 以管道实现实体归一的实践细节、早期文档是否存在 "object group" 命名。其余关键论断均已在正文中给出上述一手出处。
