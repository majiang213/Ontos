// 验收问题集：GET 列表 / POST 新增 / DELETE 删除；POST /api/questions?run=1 全量跑一遍。
// 跑法：逐条经 LLM 槽位编译后交引擎执行——编译或执行出错记「失败」，正常出数记「通过」。
// 答错即本体或映射有误，回 M2/M3 修正。

import { NextResponse } from "next/server";
import { z } from "zod";
import { runQuery } from "@/lib/engine/query";
import { getSlot } from "@/lib/engine/llmSlot";
import { getDriverRegistry } from "@/lib/engine/load";
import { getPublished } from "@/lib/engine/configStore";
import { metaStore } from "@/lib/meta/store";
import { BadRequest, bodyJson, internalError, requireWriteAuth, wsOf } from "@/app/api/_shared";

export async function GET(req: Request) {
  try {
    return NextResponse.json({ questions: await metaStore().listQuestions(wsOf(req)) });
  } catch (e) {
    return internalError(e);
  }
}

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  const url = new URL(req.url);
  if (url.searchParams.get("run")) {
    try {
      const ws = wsOf(req);
      const config = (await getPublished(ws)).config;
      const version = (await getPublished(ws)).version;
      const slot = getSlot();
      const results = [];
      for (const q of await metaStore().listQuestions(ws)) {
        let status = "通过";
        let detail = "";
        try {
          const query = await slot.nlToQuery(q.question, config);
          const { rows } = await runQuery(config, await getDriverRegistry(ws), query);
          // expected 是数字时按行数比对，不符记失败
          if (q.expected && /^\d+$/.test(q.expected.trim()) && rows.length !== Number(q.expected.trim())) {
            status = "失败";
            detail = `期望 ${q.expected} 行，实得 ${rows.length} 行`;
          }
        } catch (e) {
          status = "失败";
          detail = e instanceof Error ? e.message : String(e);
        }
        await metaStore().setQuestionStatus(ws, q.id, status, version);
        results.push({ id: q.id, question: q.question, status, detail });
      }
      return NextResponse.json({ results, version });
    } catch (e) {
      return internalError(e);
    }
  }
  try {
    const { question, expected } = z.object({ question: z.string().min(1), expected: z.string().optional() }).parse(await bodyJson(req));
    await metaStore().addQuestion(wsOf(req), question, expected);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "请求形状不合法" }, { status: 400 });
    if (e instanceof BadRequest) return NextResponse.json({ error: e.message }, { status: 400 });
    return internalError(e);
  }
}

export async function DELETE(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  try {
    const { id } = z.object({ id: z.number() }).parse(await bodyJson(req));
    await metaStore().removeQuestion(wsOf(req), id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "请求形状不合法" }, { status: 400 });
    if (e instanceof BadRequest) return NextResponse.json({ error: e.message }, { status: 400 });
    return internalError(e);
  }
}
