// 版本历史与回滚：GET /api/versions 列表；POST /api/versions { version } 回滚到该版。
// 回滚是 Git revert 语义：旧内容作为新版本发布，历史链不断。

import { z } from "zod";
import { listVersions, rollbackTo } from "@/server/engine/configStore";
import { bodyJson, requireWriteAuth, respond, wsOf } from "@/app/api/_shared";

export async function GET(req: Request) {
  return respond(async () => ({
    versions: (await listVersions(wsOf(req))).map((v) => ({ version: v.version, createdAt: v.createdAt })),
  }));
}

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  return respond(async () => {
    const { version } = z.object({ version: z.number().int().positive() }).parse(await bodyJson(req));
    const result = await rollbackTo(version, wsOf(req));
    return { ok: true, version: result.version };
  });
}
