# 待办与后续方向

## 问数 API 台账（移除于 2026-08-21，方向保留）

**是什么**：问数时编译出的结构化查询（已过 Zod 校验），命名保存为可复用 API；台账按工作空间隔离，点了直接重跑，不再惊动 LLM 编译。

**当时为什么砍**：只有存储没有兑现价值——没有"按名执行"端点（前端是 GET 列表后拿 JSON 走 `/api/query`），没有外部消费者（MCP 工具不碰它），UI 无删除入口，功能上等同收藏夹。

**加回来时该补齐的**：

- 按名/按 ID 执行端点（如 `POST /api/saved-queries/:id/run`），让名字成为稳定调用入口
- 接进 MCP 工具列表，外部 Agent 可按名调用
- UI 补删除入口

**旧实现去哪找**：移除当次提交前的 git 历史，涉及 `src/app/api/saved-queries/route.ts`、`src/server/meta/store.ts`（`ont_query_api` 表 + `saveQueryApi`/`listQueryApis`/`deleteQueryApi`）、`src/components/ChatPage.tsx`（台账 chips + 答案卡保存表单）、`src/tests/metaStore.test.ts`。
