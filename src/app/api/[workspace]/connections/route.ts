// 连接管理：GET 列表（剥掉密码与 options）/ POST 保存 / DELETE 删除。
// 薄适配：形状校验 + 写闸 → connections.saveConnection / dropConnection。

import { z } from "zod";
import { engineEnv } from "@/server/runtime";
import { dropConnection, saveConnection } from "@/server/infra/connections";
import { connectionInUse } from "@/server/features/ontology/refs";
import { getPublished } from "@/server/features/ontology/current";
import { NAME_RE } from "@/server/schema/ops";
import { metaStore } from "@/server/meta/store";
import { MSG } from "@/server/errors";
import { bodyJson, rejectRes, requireWriteAuth, respond, workspaceOf } from "@/app/api/_shared";

const connectionSchema = z.object({
  name: z.string().regex(NAME_RE, MSG.connectionNameBad),
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

export async function GET(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  return respond(async () => {
    // 密码、options、db_name 不外发（db_name 落库前被 resolve 成服务器绝对路径，路径不出网）
    const connections = (await metaStore().listConnections(await workspaceOf(params))).map(
      ({ ro_pass: _a, rw_pass: _b, options: _c, db_name: _d, ...rest }) => rest
    );
    return { connections };
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  return respond(async () => {
    const { test, ...rec } = connectionSchema.parse(await bodyJson(req));
    const r = await saveConnection(await workspaceOf(params), rec, test);
    if (r.code !== 200) return rejectRes(r);
    return r.value;
  }, { zod: { status: 400, error: MSG.zodConnectionShape } });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  return respond(async () => {
    const { name } = z.object({ name: z.string().min(1) }).parse(await bodyJson(req));
    const workspace = await workspaceOf(params);
    // 引用判定在引擎（refs.connectionInUse 纯函数）；infra/connections 不反向依赖 draft，由这里注入
    const r = await dropConnection(workspace, name, async (n) => connectionInUse((await getPublished(engineEnv(), workspace)).config, n));
    if (r.code !== 200) return rejectRes(r);
    return { ok: true };
  });
}
