// M7 查询服务：POST /api/query
// 薄适配：解析并校验查询 JSON → 引擎按已发布配置求值 → 答案行 + 取数路径 + 留痕（不存结果集）。
// 自然语言 → 查询 JSON 是 Agent 的活（LLM 槽位），不在这条路由里。

import { queryRequestSchema } from "@/server/schema/request";
import { runQuery } from "@/server/engine/query";
import { getDriverRegistry } from "@/server/engine/load";
import { getPublished } from "@/server/engine/configStore";
import { withQueryLog } from "@/server/engine/logging";
import { bodyJson, respond, wsOf } from "@/app/api/_shared";

export async function POST(req: Request) {
  return respond(async () => {
    const ws = wsOf(req);
    const query = queryRequestSchema.parse(await bodyJson(req));
    return withQueryLog(ws, { query_json: JSON.stringify(query) }, async () => {
      const { rows, path } = await runQuery((await getPublished(ws)).config, await getDriverRegistry(ws), query);
      return { rows, path };
    });
  });
}
