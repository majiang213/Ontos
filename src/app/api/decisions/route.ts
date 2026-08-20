// 裁决：POST /api/decisions
// 定案只能是人。五种结论；子类型本期不定案。定案写进草稿 + 留痕落库（含证据快照）。

import { NextResponse } from "next/server";
import { z } from "zod";
import { adjudicate } from "@/server/engine/adjudicate";
import { getDraft } from "@/server/engine/configStore";
import { connectionsOf, hasSources, isCrossSource, SAME_SOURCE_OK_VERDICTS } from "@/server/engine/eligibility";
import { metaStore } from "@/server/meta/store";
import { bodyJson, requireWriteAuth, respond, wsOf } from "@/app/api/_shared";

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

export async function GET(req: Request) {
  return respond(async () => ({ decisions: await metaStore().listDecisions(wsOf(req)) }));
}

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  return respond(async () => {
    const ws = wsOf(req);
    const body = bodySchema.parse(await bodyJson(req));
    // 先裁决后留痕：裁决被校验闸回退时不留幻影记录（候选对也不能因此被永久排除）。
    // 源名要在裁决前读——「同一/阶段」会把 B 类撤掉。
    const d = (await getDraft(ws)).draft;
    const clsA = d.object_types[body.class_a];
    const clsB = d.object_types[body.class_b];
    if (!clsA || !clsB) return NextResponse.json({ error: "类不存在，先刷新画布" }, { status: 422 });
    // 资格闸走 engine 同一套谓词（eligibility.ts）：两边有源；同源对只放行不动配置的结论
    if (!hasSources(clsA) || !hasSources(clsB)) {
      return NextResponse.json({ error: "无源对象不进裁决（先给它挂来源）" }, { status: 422 });
    }
    if (!isCrossSource(clsA, clsB) && !SAME_SOURCE_OK_VERDICTS.has(body.verdict)) {
      const shared = [...connectionsOf(clsA)].filter((c) => connectionsOf(clsB).has(c));
      return NextResponse.json({ error: `这两个对象有共同来源（${shared.join("、")}），不算疑似重复` }, { status: 422 });
    }
    const sourceOf = (name: string) => Object.keys(d.object_types[name]?.sources ?? {})[0] ?? "";
    const source_a = sourceOf(body.class_a);
    const source_b = sourceOf(body.class_b);
    await adjudicate({ class_a: body.class_a, class_b: body.class_b }, body.verdict, body.stage_names, ws);
    // 留痕失败如实告诉调用方（裁决已进草稿），不装成功也不把请求炸成 500
    let recorded = true;
    try {
      await metaStore().recordDecision(ws, {
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
    return { ok: true, recorded };
  });
}
