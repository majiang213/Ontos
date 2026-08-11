# Ontos Demo（PROTOTYPE — 可丢弃）

《Ontology平台MVP设计文档 V1.4》的产品形态原型。**数据全假，状态全在内存（刷新即重置）。**

## 运行

```bash
cd demo
npm install
npm run dev   # 打开 http://localhost:3000
```

## 产品形态：对话式 GUI Agent（Kimi 式三栏）

- **左侧导航栏**：品牌 / 新建会话 / 能力入口（点击即发话，标注 M1–M7）/ 概念速查 / 会话列表
- **中间对话流**：Agent 平铺无气泡，用户浅灰胶囊；裁决卡、答案卡等交互件内嵌在对话里；底部白底输入卡片
- **右侧产物面板**：有产物才展开、可关闭——schema / 本体图+YAML / 出码产物 / 取数详情，顶部状态徽章

流程不定死：随便说，模拟 Agent（`components/chat/mockAgent.ts`，正式版换 `/api/chat` LLM loop）自己判断意图、补齐前置步骤；唯一不可跳过的是"裁决权在人"。

## 真假边界（开发思路的核心）

| 环节 | 模块 | demo 里 | MVP 里 |
|---|---|---|---|
| 连接源库 | M1 | 内存假库（`lib/sources.ts`） | drizzle-kit pull + 只读账号 |
| AI 本体草稿 | M2 | 罐头草稿 + 假延迟（`lib/ontology.ts`） | `generateObject`，结构即真实结构 |
| 交集证据 | M3 | **真实计算**：归一化 + 内存交集（`lib/normalize.ts` `lib/overlap.ts`） | 同逻辑，SQL 采样 |
| 合并本体 | M3/M4 | 真实构建 + YAML 渲染 + 裁决留痕 | 同结构，入 PostgreSQL + Git |
| 正向生成 | M5 | 字符串模板渲染（`lib/codegen.ts`） | Nunjucks 落盘 + drizzle-kit migration |
| 问数 | M7 | **真实执行**：结构化查询 → 各源下推 → identity 匹配 → 内存拼装（`lib/queryService.ts`） | 同逻辑，SQL 下推 |

LLM 插槽共三处，均标注在代码里：M2 草稿、M3 建议理由（`analyzePair` 的 `semanticHint`）、M7 问题编译（`compileQuestion`）。

## 假数据剧本

- 招聘库：50 候选人（手机号带 `+86`/连字符，验证归一化）；HR 库：40 员工，其中 17 人身份证与候选人重合 → 交集率 **34% → 建议③生命周期**
- 部门：两边 4 个部门同名 → **100% → 建议①完全等价**
- 招聘职位 JD vs HR 岗位编制：无可比对标识 → **建议⑤不合并**
- 收官问题："查所有从候选人转正的员工及其部门" → 17 行答案 + 取数路径

## 与文档的对应

五关系类型裁决、三层证据链、identity 匹配键、派生 status、数据边界（标识集合不落地、query_log 不存答案）——全部按 V1.4 实现。
