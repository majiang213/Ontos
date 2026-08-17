// 裁决：POST /api/decisions
// 定案只能是人。五种结论；子类型本期不定案（422）。定案写进草稿 + 留痕落库。

import { NextResponse } from "next/server";
import { z } from "zod";
import { adjudicate, type Verdict } from "@/lib/engine/adjudicate";
import { getPublished } from "@/lib/engine/configStore";
import { metaStore } from "@/lib/meta/store";

const bodySchema = z.object({
  class_a: z.string(),
  class_b: z.string(),
  source_a: z.string().default(""),
  source_b: z.string().default(""),
  verdict: z.enum(["同一", "部分重叠", "阶段", "仅名称相似", "跳过"]),
  stage_names: z.object({ from: z.string(), to: z.string() }).optional(),
  llm_advice: z.string().optional(),
  rate: z.number().optional(),
  decided_by: z.string().default("画布操作者"),
});

export async function GET() {
  return NextResponse.json({ decisions: metaStore().listDecisions() });
}

export async function POST(req: Request) {
  try {
    const body = bodySchema.parse(await req.json());
    adjudicate({ class_a: body.class_a, class_b: body.class_b }, body.verdict as Verdict, body.stage_names);
    metaStore().recordDecision({
      class_a: body.class_a,
      class_b: body.class_b,
      source_a: body.source_a,
      source_b: body.source_b,
      llm_advice: body.llm_advice,
      rate: body.rate,
      verdict: body.verdict,
      decided_by: body.decided_by,
      evidence: body.rate != null ? { rate: body.rate } : undefined,
    });
    return NextResponse.json({ ok: true, publishedVersion: getPublished().version });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "请求形状不合法", issues: e.issues }, { status: 400 });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
  }
}
