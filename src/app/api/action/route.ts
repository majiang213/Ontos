// M8 动作执行器：POST /api/action
// 薄适配：解析并校验写入请求 → 引擎按已发布动作执行 → 每条投影的成败 + 留痕。
// 前置不满足、公理拦截：不动任何源；投影阶段部分失败不回滚——补偿是重发同一动作或人工修库。

import { NextResponse } from "next/server";
import { actionRequestSchema } from "@/server/schema/request";
import { runAction } from "@/server/engine/action";
import { getDriverRegistry } from "@/server/engine/load";
import { getPublished } from "@/server/engine/configStore";
import { metaStore } from "@/server/meta/store";
import { withActionLog } from "@/server/engine/logging";
import { bodyJson, requireWriteAuth, respond, wsOf } from "@/app/api/_shared";

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  return respond(async () => {
    const ws = wsOf(req);
    const parsed = actionRequestSchema.parse(await bodyJson(req));
    const result = await withActionLog(ws, parsed, async () =>
      // 发号器落元数据库：重启不复位，补偿重发撞上幂等查重才成立
      runAction((await getPublished(ws)).config, await getDriverRegistry(ws), parsed, { nextSequence: (k, s) => metaStore().nextSeq(ws, k, s) })
    );
    // 领域内的失败（前置、公理、投影失败）装在结果里返回 422；抛出来的才是引擎故障
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  });
}
