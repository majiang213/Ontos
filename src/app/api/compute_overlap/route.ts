// 交集率：POST /api/overlap { class_a, class_b }
// 薄适配：形状校验 + 写闸 → 裁决流水线 overlapOf。

import { z } from "zod";
import { overlapOf } from "@/server/engine/pairs";
import { bodyJson, requireWriteAuth, respond, wsOf } from "@/app/api/_shared";

const bodySchema = z
  .object({ class_a: z.string(), class_b: z.string() })
  .refine((b) => b.class_a !== b.class_b, { message: "自己和自己不算疑似重复" });

export async function POST(req: Request) {
  const denied = requireWriteAuth(req); // 触发两列全量扫 + 写计数，口径与写端点对齐
  if (denied) return denied;
  return respond(async () => {
    const { class_a, class_b } = bodySchema.parse(await bodyJson(req));
    return overlapOf(wsOf(req), class_a, class_b);
  });
}
