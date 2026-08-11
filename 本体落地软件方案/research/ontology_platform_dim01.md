# 调研维度 1：Palantir Foundry Ontology 与 AIP 架构事实核查

## 一、Ontology 官方定义与核心构件【官方文档确认】

- **定义**：Ontology 是"组织的运营层（operational layer）"，位于已接入平台的数字资产（数据集、虚拟表、模型）之上，将其映射到现实世界对应物；多数场景下作为"组织的数字孪生"，同时包含语义元素（objects、properties、links）与动力元素（actions、functions、dynamic security）。来源：Palantir 官方文档《Overview • Ontology》 https://www.palantir.com/docs/foundry/ontology/overview/
- **Object Type**：现实世界实体或事件的模式定义；object 为单个实例，object set 为实例集合。与数据集类比：Dataset→Object type、Row→Object、Column→Property、Join→Link type。来源：官方《Core concepts》 https://palantir.com/docs/foundry/ontology/core-concepts/
- **Action Type**："用户一次性对对象、属性值、链接所做的一组变更/编辑的定义"，即单个事务；含提交时的副作用（通知、webhook 等）、参数、规则与提交校验；编辑写入 writeback 数据集。来源：官方《Action types》 https://www.palantir.com/docs/foundry/action-types/overview/
- **Functions**：服务端隔离环境执行的代码逻辑，一等支持本体（读属性、遍历链接、编辑本体），语言为 TypeScript 与 Python。来源：官方《Functions》 https://www.palantir.com/docs/foundry/functions/overview/
- **Interface**：描述对象类型形状与能力的本体类型，提供多态。来源：同《Overview • Ontology》。
- **权限模型（两层）**：①本体资源层（object/link/action types 等 schema 资源）；②数据层（对象与链接本身，含具体属性值）。来源：官方《Object permissioning》 https://www.palantir.com/docs/foundry/object-permissioning/overview/

## 二、Ontology 与数据管道的关系【官方文档确认】

- Pipeline Builder 的管道输出可以是数据集、虚拟表（virtual tables），也可以是本体构件（object types、object links、time series）。来源：官方《Pipeline Builder • Outputs》 https://palantir.com/docs/foundry/pipeline-builder/outputs-overview/
- **物化路径**：索引（indexing）由 Object Data Funnel 服务编排，分批（batch）与流（streaming）两类 Funnel 管道，将数据源索引进 Object Storage v2（OSv2）；低延迟写入可用 direct datasources。来源：官方《Object indexing • Overview》 https://www.palantir.com/docs/foundry/object-indexing/overview/
- 本体可将"索引数据+用户编辑"物化为下游数据集（materializations）。来源：官方《Materializations》 https://www.palantir.com/docs/foundry/object-edits/materializations
- **虚拟化路径**：官方概览将 virtual tables 列为本体可依托的数字资产（不复制数据的虚拟化映射）；模型（models）也可映射进本体。来源：同《Overview • Ontology》。

## 三、AIP 如何利用 Ontology【官方文档确认】

- **AIP Logic**：无代码环境，构建由 LLM 驱动、以本体数据为后盾的函数；Logic 函数输入本体对象/文本，输出对象/字符串或直接编辑本体；通过"Use LLM"块配置 Apply Action 工具让 LLM 编辑本体，Logic 函数可包装为 Action Type，并可自动化执行或暂存人工审核。来源：官方《AIP Logic • Overview》 https://palantir.com/docs/foundry/logic/overview/
- **AIP Chatbot Studio（原 Agent Studio）**：构建由 LLM、Ontology、文档、自定义工具驱动的聊天机器人；可将对象集作为 Ontology context（检索上下文），可经 OSDK 与平台 API 外部部署。来源：官方《AIP Chatbot Studio • Overview》 https://palantir.com/docs/foundry/chatbot-studio/overview/
- **权限约束 AI**：官方原话——AIP 应用"建立在治理整个平台的同一严格安全模型之上，这些平台安全控制只授予 LLM 完成任务所必需的访问权限"（含用户与函数权限）。
- 官方另有 Palantir MCP，供外部 AI IDE/Agent 获取本体上下文。来源：官方《AIP features》 https://www.palantir.com/docs/foundry/aip/aip-features/
- 【二手观点】"OAG（Ontology Augmented Generation）"及"LLM 提出工具调用请求、平台在调用者权限内校验执行"等表述来自分析文章，非官方文档原文。来源：CSDN《解密 Palantir 系列三：AIP》 https://blog.csdn.net/cwt0408/article/details/162914997

## 四、商业价值主张【官方确认】

- Ontology"代表企业中的**决策**而非仅仅是数据"（decision-centric）；每个运营决策由四要素构成：Data、Logic、Action、Security；支持决策血缘（decision lineage）自动捕获、人机协同（Human+Agent）实时决策。来源：官方《Why create an Ontology?》 https://www.palantir.com/docs/foundry/ontology/why-ontology/
- 营销定位："编排 Human+AI 团队决策的中枢系统""驱动自主运营（Power autonomous operations）""数字孪生"。来源：Palantir 官网《Ontology》产品页 https://www.palantir.com/platforms/ontology/

## 五、开发者接口【官方文档确认】

- **Ontology SDK（OSDK）**：从开发环境直接访问本体全部能力；支持 TypeScript（NPM）、Python（Pip/Conda）、Java（Maven）、其他语言经 OpenAPI；经 Developer Console 创建应用，token 仅限定于所选本体实体且叠加用户自身权限（secure by design）；可按本体生成强类型代码。来源：官方《Ontology SDK • Overview》 https://www.palantir.com/docs/foundry/ontology-sdk/overview/
- **Platform SDK**：官方开源 Python/TypeScript 绑定（github.com/palantir/foundry-platform-python、foundry-platform-typescript）。注意：平台 API 对本体的 Object/Action/Link/Query Type 定义仅支持 GET/LIST 读取，创建仍需 UI（Ontology Manager）；Ontology-as-code 为较新能力。

**说明**：主体内容均经 Palantir 官方文档/官网逐条核实；中文官方页为机器翻译，引用时已回溯英文原文路径。二手资料的分析性表述已单独标注，未与官方事实混用。
