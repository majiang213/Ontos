// M7 查询服务：POST /api/query
// 薄适配：解析并校验查询 JSON → 引擎按已发布配置求值 → 答案行 + 取数路径 + 留痕（不存结果集）。
// 自然语言 → 查询 JSON 是 Agent 的活（LLM 槽位），不在这条路由里。

import { queryRequestSchema } from "@/server/schema/request";
import { query } from "@/server/engine/query/query";
import { getDriverRegistry } from "@/server/engine/infra/load";
import { getPublished } from "@/server/engine/config/configStore";
import { withQueryLog } from "@/server/engine/infra/logging";
import { bodyJson, respond, wsOf } from "@/app/api/_shared";

export async function POST(req: Request) {
  return respond(async () => {
    const ws = wsOf(req);
    const parsed = queryRequestSchema.parse(await bodyJson(req));
    return withQueryLog(ws, { query_json: JSON.stringify(parsed) }, async () => {
      const { rows, path } = await query((await getPublished(ws)).config, await getDriverRegistry(ws), parsed);
      return { rows, path };
    });
  });
}
