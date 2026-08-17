// 问数：POST /api/ask
// 自然语言 → 查询 JSON 走 LLM 槽位（没有 key 时是离线确定性回退）。
// 形状与槽位产物一致，过 Zod；执行是引擎的活。

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { runQuery } from "@/lib/engine/query";
import { EngineReject } from "@/lib/engine/individual";
import { getSlot } from "@/lib/engine/llmSlot";
import { demoDriver, loadConfig } from "@/lib/engine/load";

export async function POST(req: Request) {
  try {
    const { question } = (await req.json()) as { question: string };
    if (!question?.trim()) return NextResponse.json({ error: "问题为空" }, { status: 400 });
    const config = loadConfig();
    const query = await getSlot().nlToQuery(question, config);
    const { rows, path } = await runQuery(config, demoDriver(), query);
    return NextResponse.json({ question, query, rows, path });
  } catch (e) {
    if (e instanceof ZodError) return NextResponse.json({ error: "请求形状不合法", issues: e.issues }, { status: 400 });
    if (e instanceof EngineReject) return NextResponse.json({ error: e.message }, { status: 422 });
    return NextResponse.json({ error: "引擎内部错误", detail: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
