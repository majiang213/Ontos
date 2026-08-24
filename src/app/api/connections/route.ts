// 连接管理：GET 列表（剥掉密码与 options）/ POST 保存 / DELETE 删除。
// 薄适配：形状校验 + 写闸 → load.saveConnection / dropConnection。

import { z } from "zod";
import { dropConnection, saveConnection } from "@/server/engine/infra/load";
import { metaStore } from "@/server/meta/store";
import { bodyJson, requireWriteAuth, respond, wsOf } from "@/app/api/_shared";

const connectionSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, "连接名必须是小写字母/数字/下划线"),
  type: z.enum(["mysql", "pg", "sqlite"]),
  host: z.string().optional(),
  port: z.number().int().optional(),
  db_name: z.string().optional(),
  ro_user: z.string().optional(),
  ro_pass: z.string().optional(),
  rw_user: z.string().optional(),
  rw_pass: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  test: z.boolean().optional(),
});

export async function GET(req: Request) {
  return respond(async () => {
    // 密码、options、db_name 不外发（db_name 落库前被 resolve 成服务器绝对路径，路径不出网）
    const connections = (await metaStore().listConnections(wsOf(req))).map(
      ({ ro_pass: _a, rw_pass: _b, options: _c, db_name: _d, ...rest }) => rest
    );
    return { connections };
  });
}

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  return respond(async () => {
    const { test, ...rec } = connectionSchema.parse(await bodyJson(req));
    return saveConnection(wsOf(req), rec, test);
  }, { zod: { status: 400, error: "连接形状不合法" } });
}

export async function DELETE(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  return respond(async () => {
    const { name } = z.object({ name: z.string().min(1) }).parse(await bodyJson(req));
    await dropConnection(wsOf(req), name);
    return { ok: true };
  });
}
