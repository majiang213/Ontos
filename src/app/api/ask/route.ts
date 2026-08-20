// 问数：POST /api/ask
// 自然语言 → 查询 JSON 走 LLM 槽位（没有 key 时是离线确定性回退）。
// 形状与槽位产物一致，过 Zod；执行是引擎的活。

import { z } from "zod";
import { runQuery } from "@/server/engine/query";
import { getSlot } from "@/server/engine/llmSlot";
import { getDriverRegistry } from "@/server/engine/load";
import { getPublished } from "@/server/engine/configStore";
import { withQueryLog } from "@/server/engine/logging";
import { bodyJson, respond, wsOf } from "@/app/api/_shared";

export async function POST(req: Request) {
  return respond(async () => {
    const ws = wsOf(req);
    // zod 收：body 是 null/标量/缺字段都归 400
    const question = z.object({ question: z.string().min(1) }).parse(await bodyJson(req)).question.trim();
    const config = (await getPublished(ws)).config;
    const query = await getSlot().nlToQuery(question, config);
    const out = await withQueryLog(ws, { question, model: getSlot().name, query_json: JSON.stringify(query) }, async () =>
      runQuery(config, await getDriverRegistry(ws), query)
    );
    return { question, query, rows: out.rows, path: out.path };
  });
}
