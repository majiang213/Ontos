# Palantir Foundry 本体论概念：官方一手文档来源

> 研究日期：2026-09-30。本文只收录 Palantir 官方文档（`palantir.com/docs/foundry`），不把博客、白皮书、社区问答或本仓库已有研究当作来源。每条都区分“可支持的主张”和“适用边界”，避免把 Foundry 的产品约束外推成 Ontos 的现行规格。
 >
> 条目数：23。

## 1. Core concepts

- **标题**：[Core concepts](https://www.palantir.com/docs/foundry/ontology/core-concepts)
- **直接 URL**：<https://www.palantir.com/docs/foundry/ontology/core-concepts>
- **它能支持的主张**：Foundry 把 Ontology 描述为对世界的分类和组织的 digital twin，并把数据集、模型映射到四类核心定义：object type 定义实体或事件，property 定义对象类型的特征，link type 定义两个对象类型之间的关系，action type 定义对象类型如何被修改。页面还给出与数据集的类比：dataset ↔ object type、row ↔ object、column ↔ property、join ↔ link type。
- **适用边界**：这是概念总览和术语对照页；数据集类比不是“Foundry 等同于关系数据库”的规范，也没有规定 Ontos 应采用哪种存储或查询实现。页面没有给出多源对象的合并规则、实体归一算法、交集率、候选对或裁决留痕模型。

## 2. Object types — Overview

- **标题**：[Object types — Overview](https://www.palantir.com/docs/foundry/object-link-types/object-types-overview)
- **直接 URL**：<https://www.palantir.com/docs/foundry/object-link-types/object-types-overview>
- **它能支持的主张**：object type 是现实实体或事件的 schema definition；object 是该类型的单个实例；object set 是多个实例的集合。对象可以由 backing datasource 提供，也可以由 action 创建；如果所有对象都由 action 创建，可以不配置 backing datasource。
- **适用边界**：该页解释类型、实例和集合的层次，不规定“一个源表必须对应一个 object type”或“多张表必须拆成多个类型”。关于按源系统拆类型是否反模式，应引用第 10 条的设计文档；关于一个类型挂多个数据源，应引用第 8 条 MDO 文档。

## 3. Create an object type

- **标题**：[Create an object type](https://www.palantir.com/docs/foundry/object-link-types/create-object-type)
- **直接 URL**：<https://www.palantir.com/docs/foundry/object-link-types/create-object-type>
- **它能支持的主张**：每个 object type 都需要 primary key；数据源支撑的每条记录必须有不同的主键值。官方建议主键是确定性的、由一列或多列的函数得到，并警告不要使用会在构建之间变化的行号或随机值；重复主键在 Object Storage v2 的 Funnel batch pipeline 中会导致构建失败。该页还说明已有数据源的列可映射为属性，以及“所有属性都由 actions 填充”时可以不使用 backing datasource。
- **适用边界**：这是 Foundry 的创建和索引配置指南，主键重复、确定性和 Object Storage v1/v2 的行为不能直接改写成 Ontos 的通用数据库规则。它没有定义两个源的主键交集足以证明它们是同一概念，也没有定义 object type 合并、候选对、对齐判定或裁决。

## 4. Properties — Overview

- **标题**：[Properties — Overview](https://www.palantir.com/docs/foundry/object-link-types/properties-overview)
- **直接 URL**：<https://www.palantir.com/docs/foundry/object-link-types/properties-overview>
- **它能支持的主张**：property 是现实实体或事件某项特征的 schema definition；property value 是某个对象上的该特征取值。官方把 property 类比为数据集的 column，把 property value 类比为数据集的 field。页面还列出 Foundry 支持的属性基础类型及其作为 title key、primary key 的限制。
- **适用边界**：属性类型和 title/primary key 的限制是 Foundry 产品约束，不是 Ontos `properties` YAML 形状的直接规范。该页不支持“源表每一列都应原样成为属性”；属性是否有业务或技术价值、是否应派生，应引用第 9—11 条设计指导。

## 5. Link types — Overview

- **标题**：[Link types — Overview](https://www.palantir.com/docs/foundry/object-link-types/link-types-overview)
- **直接 URL**：<https://www.palantir.com/docs/foundry/object-link-types/link-types-overview>
- **它能支持的主张**：link type 是两个 object type 之间关系的 schema definition，link 是两个对象之间该关系的单个实例。同一类型的两个对象之间也可以有 link；一个 link type 是双向的，包含关系的两个 side，不需要另建反向 link type；同一对 object type 可以有多条独立 link type，但每条必须表示不同的现实关系。多对多关系由 link type 自身的 backing datasource 支撑。
- **适用边界**：该页说明关系的结构、方向和数据支撑方式，不说共享外键本身就是有意义的业务关系。是否应建立 link、关系是否需要承载日期/角色/状态，应引用第 11 条 Structural guidance；也不应据此推导出跨 Ontology 的 link 支持，页面明确不支持跨不同 Ontology 的 object type 关系。

## 6. Create a link type

- **标题**：[Create a link type](https://www.palantir.com/docs/foundry/object-link-types/create-link-type)
- **直接 URL**：<https://www.palantir.com/docs/foundry/object-link-types/create-link-type>
- **它能支持的主张**：Foundry 提供三种 link resource 形态：object type foreign keys、many-to-many 的 join table dataset、以及由中间 object 支撑的 object-backed link。foreign-key 形态支持 one-to-one 和 many-to-one；many-to-many 使用同时含两类对象主键的联结数据集；object-backed link 用中间对象承载连接本身的元数据。one-to-one cardinality 只是预期关系的指示，不会被强制执行。
- **适用边界**：这是配置向导和资源形态说明，不是领域建模判据。foreign key 能建立技术上的 link，不等于官方建议把所有共享外键都建成关系；“关系是否有语义”和“是否需要独立的关系对象”要以第 11 条为准。

## 7. Action types — Overview

- **标题**：[Action types — Overview](https://www.palantir.com/docs/foundry/action-types/overview)
- **直接 URL**：<https://www.palantir.com/docs/foundry/action-types/overview>
- **它能支持的主张**：action 是一次基于用户定义逻辑、改变一个或多个对象属性的 transaction；action type 是用户一次可提交的一组对象、属性值和 link 的变更定义，并包含提交时的 side effects。官方示例覆盖参数、规则、自动建 link、通知和授权校验；提交后的用户编辑会进入 object type 的 writeback dataset，并可供多个用户应用复用同一套逻辑与校验。
- **适用边界**：action type 表达可提交的变更和副作用，不等于通用数据清洗或批量计算工具。关于人或 agent 发起的决定应使用 action、自动转换应使用 pipeline 的分工，应引用第 9、10 条的 Golden Hammer 说明；该页也不支持把 Ontos 的 `effect`/`pre` 形状直接说成 Foundry action schema。

## 8. Multi-datasource object types (MDOs)

- **标题**：[Multi-datasource object types (MDOs)](https://www.palantir.com/docs/foundry/object-permissioning/multi-datasource-objects)
- **直接 URL**：<https://www.palantir.com/docs/foundry/object-permissioning/multi-datasource-objects>
- **它能支持的主张**：MDO 是由多个 datasource 支撑的 object type；当前仅支持 Object Storage v2，输入可以是 Foundry dataset 或 restricted view，不支持 streaming source。官方只支持 column-wise MDO：不同数据源提供同一 object type 的不同属性子集；row-wise MDO（同 schema 的 union-like 形态）本身不可用。新增数据源时需要选择一个值与 object type primary key 匹配的列；属性 multiplicity 不支持，即除 primary key 外，一个属性必须来自且只来自一个输入数据源。两个 column-wise 数据源主键集合不同时，某个主键在某数据源缺失时，该数据源映射的属性显示为 null。官方还说明 MDO 适合用户把数据理解为一个 object type 的场景；如果用户按多个概念理解和交互，也可以用多个 object type 加 link，但跨类型查询/遍历成本更高。
- **适用边界**：MDO 的不同主键集合只说明缺失源属性呈 null，不是实体解析、去重、同一概念裁决或属性冲突仲裁。不能把 row-wise MDO 当作 Foundry 当前支持的“同 schema 多源并集”；官方建议此类场景考虑 restricted views。页面另有最多 70 个 datasource 的限制，但没有给出 Ontos 交集率阈值、候选对生成、`same/overlap/stage/name_similar/skip` 判定或 `adj_decision` 留痕规则。

## 9. Ontology design: Best practices

- **标题**：[Ontology design: Best practices](https://www.palantir.com/docs/foundry/ontology/ontology-best-practices)
- **直接 URL**：<https://www.palantir.com/docs/foundry/ontology/ontology-best-practices>
- **它能支持的主张**：官方设计清单要求“model reality, not systems”：object type 应代表现实实体而不是源系统或部门的表示；属性应有明确的业务或技术价值；每个 object type 应保持一个清晰实体；需要跨团队协作；应在 action type 与 pipeline 之间按任务选择工具；共享形状宜用 interface；并应在 Ontology Manager 记录设计决定、用真实业务问题验证可导航性。该页还明确提出 DRY 目标：每个概念保持单一 canonical representation；多个类型共享属性、link、action 形状时，应评估合并为一个类型并用区分属性，或实现 shared interface。
- **适用边界**：这些是设计原则和检查清单，不是每个 Ontology 都必须满足的机器校验规则。页面有 pragmatism and tradeoffs，承认旧系统、截止时间、平台支持和团队能力会影响取舍，强调增量改进。因此它能支持“按来源拆同一现实实体会造成重复”的方向性主张，但不能支持按行交集率自动决定两个类等价，也不能替 Ontos 规定具体 YAML、画布或裁决存储。

## 10. Ontology design: Anti-patterns

- **标题**：[Ontology design: Anti-patterns](https://www.palantir.com/docs/foundry/ontology/ontology-anti-patterns)
- **直接 URL**：<https://www.palantir.com/docs/foundry/ontology/ontology-anti-patterns>
- **它能支持的主张**：官方列出与当前范围直接相关的反模式：System Silos（同一现实实体按源系统拆成多个 object type，应在管道中整合并创建统一类型）、The Kitchen Sink（把无业务价值的技术列全塞成属性）、Department Silos（各部门各建一份共享实体）、The God Object（一个类型代表多个不同实体，应拆分并用 interface 复用特征）、The Golden Hammer（所有问题都用同一个工具）、Action Sprawl（把每个单属性更新都做成独立 action，而不是按业务操作组织）、The Time Machine（把历史版本做成多个对象/类型，而不是单一实体加历史或时间序列）、The Misnomer（名称含糊或误导）。
- **适用边界**：反模式是问题识别和修复方向，不是封闭的违规清单，也不是“类型越少越好”。例如 System Silos 的解法是统一现实实体，不意味着所有相似实体都应合并；God Object 明确要求把不同实体拆开。页面没有给出 Ontos 的同一性判据、交集率门槛、候选对生命周期或对齐裁决留痕。

## 11. Ontology design: Structural guidance

- **标题**：[Ontology design: Structural guidance](https://www.palantir.com/docs/foundry/ontology/ontology-structural-guidance)
- **直接 URL**：<https://www.palantir.com/docs/foundry/ontology/ontology-structural-guidance>
- **它能支持的主张**：官方建议每个事实只存一份，以 derived property 提供便利访问；稳定、只依赖同一对象属性的值可在 pipeline 预计算，依赖 link 或 action/automation 改变的值宜用动态 derived property。关系应回答清楚的领域问题；没有关系自身元数据时可用 direct link，关系带日期、角色、状态、分配等元数据时可用 object-backed link。页面明确把“只因为两个数据集共享 foreign key 而建的 link”列为会制造噪声、混淆导航的问题，并提供命名指导：对象类型用领域专家能识别的单数具体名词，属性自明且不带实现细节，link 名称能从关系两端自然读出。
- **适用边界**：这是属性、关系、接口和命名的结构指导，不是通用领域模型模板；何时使用 pipeline 或 derived property 还取决于输入是否稳定和平台运行成本。它支持“关联链需要领域语义”的主张，但不提供 Ontos 的 `match` 关系名生成算法，也不主张用技术外键自动完成语义判定。

## 交叉使用时的结论边界

- 官方文档可以直接支持：四类核心 Ontology 要素的定义；object type、property、link type、action type 的 Foundry 结构；一个 object type 多数据源挂载的 column-wise 形态及其限制；同一现实实体避免按源系统重复建模；关系应有领域语义；动作应围绕业务操作而不是单列更新。
- 官方文档不能直接支持：Ontos 的交集率公式、按交集率生成或裁决候选对、五个英文判定键、`adj_decision` 工作记录、无对象库的实时查源库架构、YAML `sources`/`pre`/`effect` 规约，或“两个源表同一批主键就一定是同一概念”。这些是 Ontos 自己的设计，不应伪装成 Palantir 官方定义。

## 12. 历史研究引用的其他官方页面

以下页面仍被历史研究用来核对动作、连接、数据接入、索引和实体解析。它们集中列在这里；历史报告只引用本索引，不再各自维护外部 URL。

### 12. Action types overview

- **直接 URL**：<https://www.palantir.com/docs/foundry/action-types/overview>
- **用途边界**：动作类型的提交、校验与副作用；不定义 Ontos 的 YAML。

### 13. Building pipelines overview

- **直接 URL**：<https://www.palantir.com/docs/foundry/building-pipelines/overview>
- **用途边界**：管道在 Foundry 中的定位；不替代 Ontos 的查询或动作实现。

### 14. Data connection overview

- **直接 URL**：<https://www.palantir.com/docs/foundry/data-connection/overview>
- **用途边界**：数据接入与连接器边界；不规定 Ontos 的源映射键。

### 15. Interfaces overview

- **直接 URL**：<https://www.palantir.com/docs/foundry/interfaces/interface-overview>
- **用途边界**：共享接口和类型复用；不等于 Ontos 的类合并。

### 16. How edits are applied

- **直接 URL**：<https://www.palantir.com/docs/foundry/object-edits/how-edits-applied>
- **用途边界**：Foundry 对象编辑的写回说明；不替代 Ontos 的 `run_action`。

### 17. Object indexing overview

- **直接 URL**：<https://www.palantir.com/docs/foundry/object-indexing/overview>
- **用途边界**：对象索引总览；不定义 Ontos 的元库或数据边界。

### 18. Funnel batch pipelines

- **直接 URL**：<https://www.palantir.com/docs/foundry/object-indexing/funnel-batch-pipelines>
- **用途边界**：主键合并和批管道行为；不定义 Ontos 的交集率。

### 19. Type groups

- **直接 URL**：<https://www.palantir.com/docs/foundry/object-link-types/type-groups>
- **用途边界**：Foundry 类型分组；不定义 Ontos 的本体类层次。

### 20. Ontology merge scenario

- **直接 URL**：<https://www.palantir.com/docs/foundry/ontology/merge-scenario>
- **用途边界**：本体合并场景；只作外部形态参照。

### 21. Why Ontology

- **直接 URL**：<https://www.palantir.com/docs/foundry/ontology/why-ontology>
- **用途边界**：Ontology 产品定位；不替代 Ontos 的产品边界。

### 22. Gotham API object resolution basics

- **直接 URL**：<https://www.palantir.com/docs/gotham/api/revdb-resources/resolution/resolution-basics>
- **用途边界**：Gotham 实例解析背景；不定义 Ontos 的类对齐判定。

### 23. Gotham API resolve objects

- **直接 URL**：<https://www.palantir.com/docs/gotham/api/v1/revdb-resources/resolution/resolve-objects>
- **用途边界**：Gotham 解析接口背景；不定义 Ontos 的候选对或裁决留痕。
