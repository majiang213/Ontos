# 调研维度 3：MVP 聚焦竞品核查（逆向建模 / MDM 实体解析 / 代码生成）

## A. AI 逆向建模工具
- 传统工具（erwin、ER/Studio、PowerDesigner）逆向只出物理/逻辑模型，erwin v15 的 GenAI 插件仅限 DDL 生成与术语描述，不推断业务语义。
- SqlDBM 最接近：AI Copilot 批量生成表/列逻辑名与描述（语义命名雏形），与 Snowflake Semantic Views 双向同步，但面向英文云数仓、无业务对象层。https://support.sqldbm.com/hc/en-us/articles/38836665104269
- 云厂商：DataWorks 逆向建模产出数仓维度模型、靠表名下划线规则、绑自家引擎；华为云 DataArts 类似；腾讯 WeData 用大模型生成数据字典服务 NL2SQL（70%→90% 准确率），是语义增强非建模产品。
- AI 原生工具（ChartDB 22.6k★、DrawDB 38k★、Liam ERD）：schema→ER 图，物理图无语义；Bytebase 2026 盘点结论："prompt-to-diagram 成了功能而非产品"。LLM 生成 ER 语义正确率约 68–86%，研究均强调 human-in-the-loop。
- OBDA 路线：Ontop（v5.5.0，工程化成熟）本体映射全人工；Ultrawrap 半自动思路最接近本产品但公司被收购后不再活跃。
- **空白判断**：「schema + LLM → 中文业务对象模型 + 关系推断 + 人工确认流」面向存量业务库（非云数仓）的路径上无成型竞品，空白落在 SqlDBM / DataWorks / Ontop 三者交叉点。

## B. MDM 与实体解析
- 商业 MDM（Informatica 约 $20 万/年起、Reltio 中型 $2–5 万/年、SAP MDG 重咨询）全部合并「数据记录」（golden record），不做模型层产品；SAP 2026 年 3 月宣布收购 Reltio。
- 国内：用友/金蝶 MDM 绑自家 ERP；普元偏政企定制；亿信华辰睿码 EsMDM 零代码查重+留痕+信创，独立厂商中较成熟。
- 开源：Zingg（AGPL，支持中文，活跃）、Splink（MIT，可解释）、Dedupe；Senzing 商业 SDK，2026 推出 MCP "Agentic 实体解析"自动做字段映射并解释决策。
- LLM 动向：GPT-4 零样本实体匹配媲美微调模型（EDBT 2025）；LLM-matcher、MatchMaker、Agent-OM 等 schema/ontology matching 研究活跃；Semarchy 借 Snowflake Cortex 做 AI 匹配。
- **关键判断**：差异化空间真实存在（模型层整合+人工裁决+留痕+不搬数据），但三重威胁：①AI 字段映射正被大厂做成标配、会商品化；②国内零代码 MDM 下沉压价；③不搬数据解决不了存量记录冲突，须明确自身是"整合前期语义对齐层"而非 MDM 替代品，并把"裁决知识库/映射资产化"做成护城河。

## C. 模型驱动代码生成器
- JHipster 活跃但热度过峰（v9 跟 Spring Boot 4）；Amplication 活跃+AI 助手；Yeoman 生态衰退；Context Mapper 可 DDD 模型→JDL 但止步技术模型。
- Instant API（Hasura/PostGraphile/Supabase）成熟但"表即模型"；Hasura PromptQL/DDN 是唯一走语义模型的大厂动作——但定位 AI 问答不是生成应用，「语义模型→应用骨架」无人做。
- 低代码/AI 生成：Budibase/Forest Admin 连单库自动生成 CRUD 界面（最贴近 M5 但无多源整合）；百度秒哒/字节扣子冲击 CRUD 场景；v0/Lovable 产出仅 60–70% 可生产。
- 趋势共识："AI 负责建模、模板负责出码"混合路线（Flatlogic：AI 抽 schema+确定性模板）。
- **关键判断**：输入差异（多源整合本体+血缘）构成真实产出差异（生成物带溯源信息，别人拿不出），但生成器本身易复制，壁垒在本体与血缘数据质量（M1–M4），窗口期有限。
- **可复用轮子**：确定性模板出码（不用 LLM 写代码）；Alembic 迁移脚本；fastapi-crudrouter 参考；管理界面直接用 React-Admin/Refine（headless、吃 OpenAPI，自动生成 CRUD 页）；JDL 语法可借鉴。
