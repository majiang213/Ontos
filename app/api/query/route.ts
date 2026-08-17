// M7 查询服务：POST /api/query
// 薄适配：解析并校验查询 JSON → 引擎按已发布配置求值 → 答案行 + 取数路径。
// 自然语言 → 查询 JSON 是 Agent 的活（LLM 槽位），不在这条路由里。

import { NextResponse } from "next/server";
import { queryRequestSchema } from "@/lib/schema/request";
import { runQuery } from "@/lib/engine/query";
import { EngineReject } from "@/lib/engine/individual";
import { demoDriver, loadConfig } from "@/lib/engine/load";
import { ZodError } from "zod";

export async function POST(req: Request) {
  try {
    const query = queryRequestSchema.parse(await req.json());
    const { rows, path } = runQuery(loadConfig(), demoDriver(), query);
    return NextResponse.json({ rows, path });
  } catch (e) {
    if (e instanceof ZodError) return NextResponse.json({ error: "请求形状不合法", issues: e.issues }, { status: 400 });
    if (e instanceof EngineReject) return NextResponse.json({ error: e.message }, { status: 422 }); // 引擎拒绝，不猜
    return NextResponse.json({ error: "引擎内部错误", detail: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
