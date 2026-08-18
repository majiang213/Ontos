// 裁决：POST /api/decisions
// 定案只能是人。五种结论；子类型本期不定案。定案写进草稿 + 留痕落库（含证据快照）。

import { NextResponse } from "next/server";
import { z } from "zod";
import { adjudicate, type Verdict } from "@/lib/engine/adjudicate";
import { DraftReject, getDraft } from "@/lib/engine/configStore";
import { metaStore } from "@/lib/meta/store";
import { BadRequest, bodyJson, internalError, requireWriteAuth } from "@/app/api/_shared";

const bodySchema = z
  .object({
    class_a: z.string(),
    class_b: z.string(),
    verdict: z.enum(["同一", "部分重叠", "阶段", "仅名称相似", "跳过"]),
    stage_names: z.object({ from: z.string(), to: z.string() }).optional(),
    llm_advice: z.string().optional(),
    evidence: z
      .object({
        norm_rule: z.string().optional(),
        count_a: z.number().optional(),
        count_b: z.number().optional(),
        count_hit: z.number().optional(),
        rate: z.number().optional(),
      })
      .optional(),
    decided_by: z.string().default("画布操作者"),
  })
  .refine((b) => b.class_a !== b.class_b, { message: "class_a 与 class_b 不能是同一个类" });

export async function GET() {
  try {
    return NextResponse.json({ decisions: metaStore().listDecisions() });
  } catch (e) {
    return NextResponse.json({ error: "内部错误", detail: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  try {
    const body = bodySchema.parse(await bodyJson(req));
    // 先裁决后留痕：裁决被校验闸回退时不留幻影记录（候选对也不能因此被永久排除）。
    // 源名要在裁决前读——「同一/阶段」会把 B 类撤掉。
    const d = getDraft().draft;
    const clsA = d.object_types[body.class_a];
    const clsB = d.object_types[body.class_b];
    if (!clsA || !clsB) return NextResponse.json({ error: "类不存在，先刷新画布" }, { status: 422 });
    // 与候选对入口同口径：两边都得有源（无源的手工对象不进裁决）
    if (Object.keys(clsA.sources ?? {}).length === 0 || Object.keys(clsB.sources ?? {}).length === 0) {
      return NextResponse.json({ error: "无源对象不进裁决（先给它挂来源）" }, { status: 422 });
    }
    // 裁决只对跨源候选有意义：同源两个类不在这条流程里（候选对入口本就只列跨源）
    const connsOf = (t: typeof clsA) => new Set(Object.values(t.sources ?? {}).map((s) => s.connection));
    const shared = [...connsOf(clsA)].filter((c) => connsOf(clsB).has(c));
    if (shared.length > 0 && body.verdict !== "仅名称相似" && body.verdict !== "跳过") {
      return NextResponse.json({ error: `两个类共享来源 ${shared.join("、")}，不是跨源候选对` }, { status: 422 });
    }
    const sourceOf = (name: string) => Object.keys(d.object_types[name]?.sources ?? {})[0] ?? "";
    const source_a = sourceOf(body.class_a);
    const source_b = sourceOf(body.class_b);
    adjudicate({ class_a: body.class_a, class_b: body.class_b }, body.verdict, body.stage_names);
    // 留痕失败如实告诉调用方（裁决已进草稿），不装成功也不把请求炸成 500
    let recorded = true;
    try {
      metaStore().recordDecision({
        class_a: body.class_a,
        class_b: body.class_b,
        source_a,
        source_b,
        llm_advice: body.llm_advice,
        rate: body.evidence?.rate,
        evidence: body.evidence,
        verdict: body.verdict,
        decided_by: body.decided_by,
      });
    } catch {
      recorded = false;
    }
    return NextResponse.json({ ok: true, recorded });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "请求形状不合法", issues: e.issues }, { status: 400 });
    if (e instanceof BadRequest) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof DraftReject) return NextResponse.json({ error: e.message }, { status: 422 });
    if (e instanceof Error && e.message.startsWith("配置不合法")) return NextResponse.json({ error: e.message }, { status: 422 });
    return internalError(e);
  }
}
