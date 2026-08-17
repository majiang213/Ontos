// 验收问题集：GET 列表 / POST 新增 / DELETE 删除；POST /api/questions?run=1 全量跑一遍。
// 跑法：逐条经 LLM 槽位编译后交引擎执行——编译或执行出错记「失败」，正常出数记「通过」。
// 答错即本体或映射有误，回 M2/M3 修正。

import { NextResponse } from "next/server";
import { z } from "zod";
import { runQuery } from "@/lib/engine/query";
import { getSlot } from "@/lib/engine/llmSlot";
import { demoDriver, loadConfig } from "@/lib/engine/load";
import { getPublished } from "@/lib/engine/configStore";
import { metaStore } from "@/lib/meta/store";

export async function GET() {
  return NextResponse.json({ questions: metaStore().listQuestions() });
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("run")) {
    const config = loadConfig();
    const version = getPublished().version;
    const slot = getSlot();
    const results = [];
    for (const q of metaStore().listQuestions()) {
      let status = "通过";
      let detail = "";
      try {
        const query = await slot.nlToQuery(q.question, config);
        await runQuery(config, demoDriver(), query);
      } catch (e) {
        status = "失败";
        detail = e instanceof Error ? e.message : String(e);
      }
      metaStore().setQuestionStatus(q.id, status, version);
      results.push({ id: q.id, question: q.question, status, detail });
    }
    return NextResponse.json({ results, version });
  }
  const { question, expected } = z.object({ question: z.string().min(1), expected: z.string().optional() }).parse(await req.json());
  metaStore().addQuestion(question, expected);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const { id } = z.object({ id: z.number() }).parse(await req.json());
  metaStore().removeQuestion(id);
  return NextResponse.json({ ok: true });
}
