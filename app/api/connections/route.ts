// 连接管理：GET 列表（剥掉密码与 options）/ POST 保存（test:true 先测连通，通过才落库）/ DELETE 删除。
// 保存即注册进驱动注册表，即时生效；失败回滚注册。重存同名连接：先测新配置，通了再换，旧驱动最后才放。

import { NextResponse } from "next/server";
import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getDriverRegistry, registerSaved } from "@/lib/engine/load";
import { getPublished } from "@/lib/engine/configStore";
import { metaStore } from "@/lib/meta/store";
import { BadRequest, bodyJson, internalError, requireWriteAuth, wsOf } from "@/app/api/_shared";

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
  try {
    // 密码、options、db_name 不外发（db_name 落库前被 resolve 成服务器绝对路径，路径不出网）
    const connections = (await metaStore().listConnections(wsOf(req)))
      .map(({ ro_pass: _a, rw_pass: _b, options: _c, db_name: _d, ...rest }) => rest);
    return NextResponse.json({ connections });
  } catch (e) {
    return internalError(e);
  }
}

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  try {
    const { test, ...rec } = connectionSchema.parse(await bodyJson(req));
    if (rec.type === "sqlite") {
      if (!rec.db_name) return NextResponse.json({ error: "sqlite 连接必须给文件路径（db_name）" }, { status: 400 });
      // 文件必须已存在：不存在就建库等于让请求方在服务器上任意落文件
      const p = resolve(process.cwd(), rec.db_name);
      if (!existsSync(p)) return NextResponse.json({ error: `sqlite 文件不存在：${p}` }, { status: 400 });
      rec.db_name = p;
    } else if (!rec.host || !rec.db_name) {
      return NextResponse.json({ error: "mysql/pg 连接必须给 host 与 db_name" }, { status: 400 });
    }
    const ws = wsOf(req);
    const registry = await getDriverRegistry(ws);
    const previous = (await metaStore().listConnections(ws)).find((c) => c.name === rec.name); // 重存场景的旧配置，失败要还回来
    // 内置演示源（fixture，不在元库）不许同名覆盖——覆盖了失败回滚时还回不来
    if (!previous && registry.has(rec.name)) {
      return NextResponse.json({ error: `${rec.name} 是内置演示源，换个名字` }, { status: 422 });
    }
    registerSaved(registry, rec); // 先注册（registry 会关掉同名的旧驱动），测试与内省都走注册表
    if (test) {
      try {
        const tables = await registry.introspect(rec.name);
        if (tables.length === 0) {
          registry.unregister(rec.name);
          if (previous) registerSaved(registry, previous); // 还回旧连接
          return NextResponse.json({ ok: true, warning: "连上了，但库里没有表", tables, saved: false });
        }
      } catch (e) {
        registry.unregister(rec.name);
        if (previous) registerSaved(registry, previous); // 测不过：新配置撤掉，旧连接还回来
        return NextResponse.json({ error: `连不上：${e instanceof Error ? e.message : String(e)}` }, { status: 422 });
      }
    }
    await metaStore().saveConnection(ws, rec); // 测过才落库
    return NextResponse.json({ ok: true, saved: true });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "连接形状不合法", issues: e.issues }, { status: 400 });
    if (e instanceof BadRequest) return NextResponse.json({ error: e.message }, { status: 400 });
    return internalError(e);
  }
}

export async function DELETE(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  try {
    const ws = wsOf(req);
    const { name } = z.object({ name: z.string().min(1) }).parse(await bodyJson(req));
    // 演示 fixture 连接不在元库：删不了，删了会把演示源从注册表抹掉
    if (!(await metaStore().listConnections(ws)).some((c) => c.name === name)) {
      return NextResponse.json({ error: `连接不存在：${name}（内置演示源不能删）` }, { status: 422 }); // 三档分层：不存在归 422
    }
    // 已发布本体还引用着的连接不能删——删了问数/动作立刻全 422
    const inUse = Object.values((await getPublished(ws)).config.object_types).some((t) =>
      Object.values(t.sources ?? {}).some((s) => s.connection === name)
    );
    if (inUse) return NextResponse.json({ error: `连接 ${name} 仍被已发布本体引用，先改本体再删` }, { status: 422 });
    await metaStore().deleteConnection(ws, name);
    (await getDriverRegistry(ws)).unregister(name);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "请求形状不合法" }, { status: 400 });
    if (e instanceof BadRequest) return NextResponse.json({ error: e.message }, { status: 400 });
    return internalError(e);
  }
}
