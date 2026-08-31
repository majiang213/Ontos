# Palantir 官方文档核对：同一概念的表并入多源对象类型（MDO）与建模形态

- 研究日期：2026-09-01，网络可用。六份官方文档（MDO、Create an object type、Funnel batch pipelines、Ontology design 的 Best practices / Anti-patterns / Structural guidance）已 curl 抓正文核对；沿用上轮研究（`docs/research/palantir-foundry-ontology-vs-ontos.md`）已核的链接处标注「上轮已核」。
- 核对对象（新决定）：同一个概念的表（来源覆盖面可以不同：部分重合、一方是另一方的子集、时期差）并成同一个多源对象类型（MDO），行按唯一性标准对齐；时期语义用派生属性表达；match 链（带领域谓词）只属于不同概念之间的关联。

## ① 结论摘要

1. **支持**：「同一概念的表并成一个对象类型」有官方判语——System Silos 反模式把「按源系统拆类型」定性为反模式、解法是单一类型（[Anti-patterns](https://palantir.com/docs/foundry/ontology/ontology-anti-patterns/)）；Do not repeat yourself 原则要求「每个概念一个 canonical 表示」（[Best practices](https://palantir.com/docs/foundry/ontology/ontology-best-practices/)）。
2. **支持**：来源覆盖面不同（主键集合不同）时多源类型的行为，官方 FAQ 有原文——某源缺某主键时，该源映射的属性显示 null；官方未设覆盖率门槛或警告（[MDO](https://palantir.com/docs/foundry/object-permissioning/multi-datasource-objects/)）。
3. **支持**：match 链只属于不同概念——官方要求每条 link type 回答领域问题、「仅因共享外键建链」列为反模式（[Structural guidance](https://palantir.com/docs/foundry/ontology/ontology-structural-guidance/)）；God Object 反模式守住另一侧：不同实体不许硬并成一个类型（[Anti-patterns](https://palantir.com/docs/foundry/ontology/ontology-anti-patterns/)）。
4. **支持（形态相容）**：时期语义用派生属性——The Time Machine 反模式的解法是「每实体单对象 + 状态属性 + 链接历史/时间序列」；「按来源有无行派生」这一具体规则官方没有同名原语（未核对到），属 Ontos 自有实现，与官方「单对象承载状态」的形态相容。
5. **边界（未被推翻、有硬约束）**：官方 MDO 只有 column-wise（join 型）；row-wise（同 schema 整行并集）明确不支持，官方指路管道 union / restricted views。一个属性只能挂一个源（主键除外）、主键属性每个源都要有、一张数据集只能背一个对象类型、一个类型上限 70 源。
6. **推断**：「覆盖面不同只是数据事实、不是结构选择」是 Ontos 的提炼——官方各条目分别支持两半，无一句原话作此对立；「按行重合判同一概念」在官方属管道层职责（构造确定性主键），Ontos 把它前移为判定证据，是产品差异不是官方原话。

## ② 逐研究问题

### 问题 1：MDO 的官方边界——哪些表可以挂同一个 object type

- 官方定义：「A multi-datasource object type (MDO) is backed by multiple datasources in the Ontology」，仅限 Foundry 数据集或 restricted view，不支持流式源；接入每个新源时界面要求「a column with values matching the primary key of the object type」（[MDO](https://palantir.com/docs/foundry/object-permissioning/multi-datasource-objects/)）。
- **部分重合有官方行为条款**：FAQ「Which objects appear if two column-wise datasources for an object have different sets of primary keys?」答：「primary keys that do not exist in a datasource will have the properties that are mapped from that particular input datasource displayed as null」——对象集合是各源主键的并集，缺行源的属性为空。A 表 100 行、B 表 52 行、40 行重合：112 个对象，40 个双源有值、其余单源有值另一源为空。**官方没有覆盖率限制或警告**，硬约束只在列上：「a specific property of an object type must come from one—and only one—of the input datasources (except for the primary key property, which must exist in every input datasource to join all datasources)」（property multiplicity 不支持）；另有上限 70 源（[MDO](https://palantir.com/docs/foundry/object-permissioning/multi-datasource-objects/)）。
- **column-wise / row-wise 之分是关键边界**：column-wise 是「A join-like MDO case where distinct subsets of properties … can be integrated from different datasources」；row-wise 是「A union-like MDO case where full objects … sharing the same schema」——「Foundry only supports column-wise MDOs and does not support row-wise MDOs」，row-wise 用例官方指向 restricted views（[MDO](https://palantir.com/docs/foundry/object-permissioning/multi-datasource-objects/)）。Ontos 的多源类（不同列集、主键部分重合）落官方 column-wise 形态；若两表同 schema、只差行，官方标准答案是管道 union 成一个数据集，不是 MDO——Ontos 自研引擎不受此限，但引用官方依据时须写明。
- 对齐与去重在管道层：Funnel 的 merge changes 步骤把各源变更「joined by the object type's primary key」；主键必须确定性（「the primary key is the function of either a single column or multiple columns」），重复主键令批管道直接失败（[Funnel batch pipelines](https://palantir.com/docs/foundry/object-indexing/funnel-batch-pipelines/)、[Create an object type](https://palantir.com/docs/foundry/object-link-types/create-object-type/)）。
- 一张表只能背一个类型：「a single datasource can only be used to back one object type」（[Create an object type](https://palantir.com/docs/foundry/object-link-types/create-object-type/)）——与 Ontos 一表至多挂一类（一表一源映射）一致。

### 问题 2：部分重合的记录集，官方的标准建模答案

- 直接判语是 System Silos 反模式：「System Silos occur when you create separate object types for the same real-world entity based on the source system the data originates from, rather than modeling the entity itself」；解法「Create a single object type representing the real-world entity and use data pipelines to merge information from multiple source systems into a unified backing dataset」，步骤含「Identify the primary key that uniquely identifies the entity across systems」与冲突值优先级规则（[Anti-patterns](https://palantir.com/docs/foundry/ontology/ontology-anti-patterns/)）。Department Silos 同向：「Create shared object types that serve multiple departments」（[Anti-patterns](https://palantir.com/docs/foundry/ontology/ontology-anti-patterns/)）。
- 「每概念一个 canonical 表示」的原文与适用边界：出处是 DRY 原则「The goal is a single canonical representation for each concept, with a single canonical workflow for each operation on that concept」；合并评估的判据句是「If multiple object types share a common shape (same properties, similar links, similar actions), evaluate whether they should be a single type with a distinguishing property or should implement a shared interface」（[Best practices](https://palantir.com/docs/foundry/ontology/ontology-best-practices/)）。注意边界：官方的合并触发是**已建成重复类型后按形状审计**；Ontos 把判定前移到建稿期、以行重合为证据——官方没有「按行重合判同一概念」的原话，此为 Ontos 扩展，方向与上两条一致。
- 反向边界（不许并的一侧）：God Object 反模式——「One object type represents multiple distinct entities」，解法是拆开不同类型、共性交给接口（[Anti-patterns](https://palantir.com/docs/foundry/ontology/ontology-anti-patterns/)）；「Separate identity from observation: If a row represents a measurement or event about an entity, the entity and the observation are likely different object types」（[Best practices](https://palantir.com/docs/foundry/ontology/ontology-best-practices/)）——工单、保修卡这类记录行不并入主体类型，官方判据与 Ontos 的记录表建链路线一致。

### 问题 3：link type 与 MDO 的选择判据

- 官方有一道专门的 FAQ：「What is the difference between MDOs and linking two distinct object types with a foreign key relation? How should users decide between these options?」答：「MDOs are intended to provide a user-friendly way to configure the same setup as a single object type to build an organization's digital twin. Multiple object types with links between them can also be used for cases in which that is how users understand and interact with their data. Note that querying and traversing links between multiple object types is a more expensive operation than filtering on a property on the same object type」（[MDO](https://palantir.com/docs/foundry/object-permissioning/multi-datasource-objects/)）。判据两条：概念上按用户理解与交互方式分（同一种事物 → 一个类型）；性能上跨类型遍历比同类型属性过滤贵。
- 「仅因共享外键建链是噪音」的反模式条目原文：「Meaningless links — Links that exist only because two datasets share a foreign key add noise to the Ontology and confuse navigation」；对应的 best practice：「Validate semantic meaning: Avoid links that exist only because two datasets share a foreign key. Ask if the relationship is meaningful in the domain」；同页要求「Every link type should answer a clear domain question, such as: … Which equipment was used in this work order?」（[Structural guidance](https://palantir.com/docs/foundry/ontology/ontology-structural-guidance/)）。DDD 原则同向：「Links should represent real relationships ('this patient visited this facility'), not join keys or foreign key artifacts」（[Best practices](https://palantir.com/docs/foundry/ontology/ontology-best-practices/)）。
- 对照 Ontos：match 链只在「不是同一概念、且一方字段指向另一方个体」时建、须带领域谓词——与官方判据同构；Ontos 以交集率把「同一批个体」量化、Foundry 无此原语（上轮已核，Gotham object resolution 在实例层）。

### 问题 4：时期的表达

- The Time Machine 反模式原文：「The Time Machine anti-pattern occurs when you model historical versions of an entity as separate objects or object types rather than using time series data, snapshots, or proper versioning strategies」；解法「Use a single object per entity with properties for current state. Store historical changes in a separate linked object type, enable edits history, or leverage time series properties」（[Anti-patterns](https://palantir.com/docs/foundry/ontology/ontology-anti-patterns/)）——时期不立新类型、不立新对象，与 Ontos 的生命周期落地（一个类 + 阶段派生属性 + 转化动作）同侧。
- 派生属性是官方一等机制：「Store each fact once. Use derived properties for convenience」；依赖动作或链变化的值归「Dynamically derived」侧，读时现算（derived property 「stays correct automatically」），规模 <~10k objects/query 可自由用（[Structural guidance](https://palantir.com/docs/foundry/ontology/ontology-structural-guidance/)）。
- 对照「按来源有无行派生状态属性」：官方文档没有这个具体派生输入的原语（未核对到）；它读本对象各源的行有无、读时现算，落在官方「单对象 + 动态派生属性承载状态」形态内，属 Ontos 自有实现与官方形态的组合。转化动作（`convert_to_<晚阶段>`）与官方「人的决定用 action types 表达」相容（[Anti-patterns](https://palantir.com/docs/foundry/ontology/ontology-anti-patterns/) Golden Hammer 表，上轮已核）。

## ③ 仓内核对结果

**复核通过**：走查剧本三对剧情（`docs/真模型端到端测试.md` §2.2：设备×资产并一个对象挂两源、点检并入设备多源类且独有 20 台也是设备、采购×台账一个对象加时期派生；§3–§4 记录表三对全部落「不比同类、与主体建链」）；skills 四册（ontos-canvas §整合问题树「是同一个概念→合并；不是→有关联→建链」；ontos-action-run 与 ontos-query 的「部分重叠的两类已并进同一个多源类」）；ADR 0005、ADR 0006 修订段、ADR 0008、ADR 0010、ADR 0013；MVP 设计文档 §2/§4；文章 §2、§3.2 判定表与图 4、附录 B/C；README §二步骤与流程图（落地画的是「设备对象 双源 + 阶段字段」）。

**残留冲突（旧 ADR 0013 口径「两类保留、自动建 match 链」未跟改，共 6 处文档）**：

| # | 落点 | 现文 | 应为 |
|---|---|---|---|
| 1 | `CONTEXT.md:79`（上位对象·已废条） | 「ADR 0013 起部分重叠的落地是两类各自保留、自动建带领域谓词的 match 链」 | 并成同一个多源类。CONTEXT 是概念定义唯一出处，权重最高 |
| 2 | `CONTEXT.md:90`（判定办法） | 「类等价与部分重叠都可能，人选是并成一个类还是保留两个类」 | 「保留两个类」已不是同一概念的落地选项；执行者已是 Agent（两处旧） |
| 3 | `docs/Ontology平台MVP设计文档.md:489`（附录A 上位对象行） | 「部分重叠落地为两类各自保留、自动建带领域谓词的 match 链」 | 同 #1 |
| 4 | `docs/ontos-article.md:128` | 「部分重叠的两类各自保留、互不继承，靠链连起来」 | 与同文件 121 行「并入同一个多源类」直接矛盾 |
| 5 | `docs/ontos-article.md:1293`（附录A 上位对象行） | 「ADR 0013 起两类各自保留、自动建带领域谓词的 match 链」 | 同 #1 |
| 6 | `docs/adr/0012-test-scenario.md:3`（修订注记②）与 `:11`（清单引言） | 「已被 ADR 0013 取代（两类保留、自动建带领域谓词的链）」「见 ADR 0013——自动建链，不立公共对象」 | 注记对 0013 的转述须跟最终口径；清单第 2 对「部分重叠」作留痕键名可保留，清单已标「重推前仅作历史对照」 |

**实现层旧口径（预期内——规格任务票 T3/T6 未执行）**：`src/server/features/integrate/applyVerdict.ts:3`、`:179` 与 `src/tests/fieldsUpdate.test.ts:119`、`:127` 仍是「两类保留建链 + 写 class_conclusions」。

**随实现迁移需同步（非本决定的直接冲突）**：`README.md:144`（「裁决面板」）、`README.md:174`（裁决能力按「类等价 / 部分重叠 / 生命周期 / 同形异义」点名——留痕键可留，能力描述随判定收敛更新）；`docs/adr/0006-class-conclusions.md:7` 旧正文（「都只投影 `class_conclusions`」）与第 5 行修订注记并存、无废止标记。

## ④ 引用清单

本轮抓正文核对（2026-09-01）：

1. Multi-datasource object types (MDOs) — https://palantir.com/docs/foundry/object-permissioning/multi-datasource-objects/
2. Create an object type — https://palantir.com/docs/foundry/object-link-types/create-object-type/
3. Funnel batch pipelines — https://palantir.com/docs/foundry/object-indexing/funnel-batch-pipelines/
4. Ontology design: Best practices — https://palantir.com/docs/foundry/ontology/ontology-best-practices/
5. Ontology design: Anti-patterns — https://palantir.com/docs/foundry/ontology/ontology-anti-patterns/
6. Ontology design: Structural guidance — https://palantir.com/docs/foundry/ontology/ontology-structural-guidance/

沿用上轮研究已核（2026-09-01，见 `docs/research/palantir-foundry-ontology-vs-ontos.md`）：

7. Link types overview — https://palantir.com/docs/foundry/object-link-types/link-types-overview/
8. Create a link type — https://palantir.com/docs/foundry/object-link-types/create-link-type/
9. Object types overview — https://palantir.com/docs/foundry/object-link-types/object-types-overview/
10. Ontology core concepts — https://palantir.com/docs/foundry/ontology/core-concepts/
11. Gotham API: Object resolution basics — https://palantir.com/docs/gotham/api/revdb-resources/resolution/resolution-basics/

未核对项：「按来源有无行派生状态属性」在官方无同名原语（Ontos 自有实现）；row-wise MDO 的 restricted-view 替代细节仅据 MDO 页 FAQ 一句指路、未逐页展开；官方文档树内 entity resolution 专页仍未见（上轮已查四节导航）。
