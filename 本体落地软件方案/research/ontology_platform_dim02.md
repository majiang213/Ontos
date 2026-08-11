# 调研维度 2：通用 Ontology / 语义层 / 知识图谱赛道竞品扫描

## 一、国际厂商

**1. Palantir Foundry（Ontology 标杆）**
定位：以 Ontology（对象类型+关系+动作 Action+函数）为核心的运营决策平台，AIP/Workshop/OSDK 均围绕本体构建，并已通过 MCP 向外部 Agent 开放。差距：深度绑定 Foundry 生态，数据须经管道迁入索引（非就地查询），封闭且昂贵。来源：https://www.puppygraph.com/blog/palantir-ontology

**2. Microsoft Fabric IQ（Ontology, 预览）**
定位：在 Fabric 中新增本体项（实体/关系/属性/规则/动作），可由 Power BI 语义模型一键生成本体，配 Operations Agent 监控实时数据并"采取受治理的行动"。差距：预览阶段，数据绑定限制多（仅托管 Lakehouse 表、Import/DirectQuery 模式受限），强绑微软生态。来源：https://learn.microsoft.com/en-us/fabric/iq/overview

**3. dbt Semantic Layer（MetricFlow）**
定位：YAML/Git 化指标语义层，MetricFlow 已开源（Apache 2.0），经 API 供 BI 与 AI Agent 消费（官方基准显示 Agent 走语义层准确率近 100%）。差距：只读指标语义，无对象/关系模型、无 Action/写回。来源：https://docs.getdbt.com/docs/use-dbt-semantic-layer/dbt-sl

**4. Cube**
定位：API 优先的通用语义层（SQL/REST/GraphQL+缓存引擎），2025 年推出 D3 Agentic Analytics，Agent 作为语义层消费者。差距：面向分析场景，无业务写回与本体动作语义。来源：https://datus.ai/blog/cube-agentic-analytics/

**5. AtScale**
定位：企业级通用语义层，多协议（SQL/MDX/DAX），开源 SML 建模语言，MCP Server 向 LLM 暴露语义模型。差距：纯分析语义层，模型靠手工维护，无 Action。来源：https://www.atscale.com/use-cases/universal-semantic-layer/

**6. Stardog**
定位：企业知识图谱（EKG）+数据虚拟化（OBDA 范式，R2RML 映射、联邦查询、推理）。差距：读写面向 RDF 图谱本身，无面向业务系统的 Action 框架；AI 消费需自建。来源：https://arxiv.org/pdf/2304.09029

**7. Neo4j**
定位：属性图数据库龙头，GraphRAG 生态最成熟（neo4j-graphrag 包、LLM Graph Builder、Aura Agent 低代码建 Agent）。差距：是数据库而非本体平台，无业务对象建模/写回编排。来源：https://neo4j.com/blog/genai/build-context-aware-graphrag-agent/

**8. Ontotext GraphDB / 9. TopQuadrant EDG / 10. Altair Graph Studio**
GraphDB：RDF 库+OWL 推理，可用 Semantic Object Service 由本体自动生成 GraphQL Schema（偏存储与检索）。TopBraid EDG：本体/词表/术语表治理（SHACL），强治理弱运行时。Graph Studio（原 Cambridge Semantics Anzo）：语义驱动的数据编织/Data Fabric。三者均无 Action/Agent 消费设计。来源：https://www.ontotext.com/blog/ontotexts-graphdb-builds-thriving-community/ 、https://taxonomystrategies.com/taxonomy-tools/

**11. Protégé / WebProtégé**
定位：斯坦福开源 OWL2 本体编辑器，支持协作、版本历史、推理机（HermiT/Pellet）。差距：学术建模工具，与企业数据/动作/AI 完全脱节。来源：https://protege.stanford.edu/software/

## 二、中国厂商

**明略科技**：以行业知识图谱+企业知识中台见长，深耕公安、零售/营销场景。差距：以项目制图谱应用为主，缺通用本体运行时与 Action 写回。来源：https://blog.csdn.net/xc202603/article/details/161930025（第三方评测，置信度中等）

**海致星图**：自研分布式图数据库 AtlasGraph+Atlas 知识图谱平台+DMC 图谱数据管理，金融反欺诈/营销闭环，流批图一体。差距：定位"图分析+图应用"，本体为构图服务，无业务系统写回。来源：https://www.yun88.com/product/6023.html

**星环科技 Sophon KG**：全生命周期 KG 平台（蓝图拖拽构图、本体定义模块、NLP 抽取、StellarDB 万亿边存储），通过信通院评测。差距：面向图谱构建与分析，无 Action 概念，AI 结合停留在"图谱+大模型问答"。来源：https://www.transwarp.cn/subproduct/sophon-kg

**华为云 KG / 百度智能云知识图谱**：云上图谱构建服务，支持本体（概念/关系）编辑、信息抽取、图谱问答。差距：工具链形态，本体仅服务构图，无运行时对象/动作。来源：https://support.huaweicloud.com/usermanual-kg/kg_01_0045.html

**阿里云 DataWorks 智能数据建模**：数据中台侧代表——数仓规划、维度建模（Kimball）、指标、逆向建模（存量物理表反向生成模型，直接回应"现有系统映射改造"需求，但产出是数仓表模型而非本体）。差距：无对象/关系/动作语义，不供 Agent 消费。来源：https://help.aliyun.com/zh/dataworks/user-guide/reverse-modeling

## 三、可复用开源生态

- **数据接入**：Airbyte（600+连接器，开源 CDK）、Singer（tap/target 协议，Meltano 编排）——可复用为"现有系统映射"的连接器底座。来源：https://airbyte.com/top-etl-tools-for-sources/elt-tools
- **API 自动生成**：Hasura/PostGraphile 由库表自动生成含 Mutation 的 GraphQL（自带订阅、行级权限），可作为本体对象读写 API 层的参考实现。来源：https://www.pkgpulse.com/blog/grafbase-vs-hasura-vs-postgraphile-instant-graphql-apis-2026
- **图存储**：NebulaGraph（国产开源分布式图库，万亿级）、MetricFlow（指标语义开源）、Ontop（OBDA 虚拟图谱）、WebProtégé（协作本体建模，可自部署）。

## 四、市场空白点小结

四块能力各自有主：**通用本体建模**（Palantir、Fabric IQ、TopQuadrant）、**现有系统映射/逆向改造**（DataWorks 逆向建模、Stardog 虚拟化、Airbyte 连接器）、**Action 写回**（仅 Palantir 与 Fabric IQ 预览版原生支持，Hasura 提供技术雏形）、**AI Agent 消费本体**（dbt/Cube/AtScale 以只读指标语义+API/MCP 切入，Neo4j 以 GraphRAG 切入）。**目前没有一款产品（尤其中文/国产化语境下）把四者打通**：以通用本体（对象+关系+动作）为中枢，既能把存量业务系统低成本映射、逆向纳入本体，又能让 Agent 经本体读取语义、并通过受治理的 Action 写回业务系统形成闭环。Palantir 最接近但封闭且与国产化无缘；Fabric IQ 方向正确但尚在预览且锁微软生态；国内厂商整体仍停留在"图谱构建+分析"，Action 与 Agent 原生消费基本空白——这正是产品的差异化机会窗口。
