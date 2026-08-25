// 验收问题集：GET 列表（带当前已发布版本，界面据此标「待重跑」）/ POST 新增 / DELETE 删除。
// POST /api/questions?run=1 全量跑一遍；body 给 { id } 时只跑那一条；&target=draft 对当前草稿试跑，结果不落验收记录。
// 失败分阶段记（编译失败/执行出错/答案不符），原因落 detail。跑批逻辑在 engine/query/questions。

import { z } from "zod";
import { getPublished } from "@/server/engine/draft/current";
import { EXPECTED_HINT, parseExpected, runQuestions } from "@/server/engine/query/questions";
import { metaStore } from "@/server/meta/store";
import { MSG } from "@/server/errors";
import { BadRequest, bodyJson, requireWriteAuth, respond, wsOf } from "@/app/api/_shared";

export async function GET(req: Request) {
  return respond(async () => {
    const ws = wsOf(req);
    return { questions: await metaStore().listQuestions(ws), version: (await getPublished(ws)).version };
  });
}

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  const url = new URL(req.url);
  if (url.searchParams.get("run")) {
    return respond(async () => {
      const ws = wsOf(req);
      const target = url.searchParams.get("target") === "draft" ? ("draft" as const) : ("published" as const);
      // 跑批允许空体（全量）；非空才按 { id } 解。裸 JSON.parse 的 SyntaxError 归一成 400
      const raw = await req.text();
      let onlyId: number | undefined;
      if (raw.trim()) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new BadRequest(MSG.bodyNotJson);
        }
        onlyId = z.object({ id: z.number().int().optional() }).parse(parsed).id;
      }
      const { results, version } = await runQuestions(ws, { onlyId, target });
      if (onlyId !== undefined && results.length === 0) throw new BadRequest(MSG.questionNotFound);
      return { results, version };
    });
  }
  return respond(async () => {
    const { question, expected } = z.object({ question: z.string().min(1), expected: z.string().optional() }).parse(await bodyJson(req));
    if (parseExpected(expected) === null) throw new BadRequest(EXPECTED_HINT); // 写法在录入时就拦，不留到跑批才炸
    await metaStore().addQuestion(wsOf(req), question, expected?.trim() || undefined);
    return { ok: true };
  });
}

export async function DELETE(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  return respond(async () => {
    const { id } = z.object({ id: z.number() }).parse(await bodyJson(req));
    await metaStore().removeQuestion(wsOf(req), id);
    return { ok: true };
  });
}
