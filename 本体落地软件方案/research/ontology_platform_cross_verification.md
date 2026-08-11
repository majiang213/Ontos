# 交叉验证：Ontology 平台调研结论一致性核查

## 一致结论（两份调研互证）
1. **Ontology = 语义（对象/属性/关系）+ 动力（动作/函数/安全）双层结构**：Palantir 官方文档确认，且竞品扫描显示其他厂商多只覆盖语义层，动力层（Action）是稀缺能力。两源一致。
2. **AI 消费本体的正确范式是"权限内工具调用"**：Palantir 官方确认 AIP 复用平台安全模型约束 LLM；dbt/AtScale/Cube 以语义层 API/MCP 供 Agent 消费的做法印证"本体/语义层是 Agent 可靠性的地基"（dbt 官方基准：Agent 走语义层准确率近 100%）。
3. **现有系统改造的两条技术路径（虚拟化/物化）均为业界验证**：Palantir 有 indexing（物化）与 virtual tables（虚拟化）；Stardog/Ontop 走 OBDA 虚拟化；DataWorks 走逆向建模。可放心采用三模式设计。

## 需注意的不确定点
- Microsoft Fabric IQ 处于预览期，功能与限制变化快，引用时标注"截至 2026 年初预览版"。
- 明略科技等国内厂商产品细节公开资料少，相关判断置信度中等，文档中避免绝对化表述。
- Palantir 平台 API 对本体定义多为只读（GET/LIST），建模仍需 UI——这一事实可作为我方"Ontology-as-Code 全自动 API"的差异化论据。
