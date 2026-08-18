// MCP 端点（最小自实现）：外部 Agent 经这里调 Ontos 的工具。
// tools/list 列出工具；tools/call 执行。循环不做进 Ontos——外部 Agent 是调用方。

import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { actionRequestSchema, queryRequestSchema } from "@/lib/schema/request";
import { runQuery } from "@/lib/engine/query";
import { runAction } from "@/lib/engine/action";
import { EngineReject } from "@/lib/engine/individual";
import { getSlot } from "@/lib/engine/llmSlot";
import { listClasses, readClass, search } from "@/lib/engine/views";
import { demoDriver, loadConfig } from "@/lib/engine/load";
import { getPublished } from "@/lib/engine/configStore";
import { metaStore } from "@/lib/meta/store";
import { BadRequest, bodyJson, safeLog } from "@/app/api/_shared";

const TOOLS = [
  { name: "query", description: "按已发布本体执行结构化查询（只读）。入参：{ query: 查询 JSON }" },
  { name: "run_action", description: "执行一条已发布动作。入参：{ action, object, identity, request? }" },
  { name: "propose_ontology", description: "对选中的表产本体草稿建议（不落画布）。入参：{ tables: [{ connection, table }] }" },
  { name: "propose_action", description: "对某类产一条动作定义草稿（不发布）。入参：{ object }" },
  { name: "list_classes", description: "列出本体里全部的类（名字与说明）。入参：{}" },
  { name: "read_class", description: "读取一个类的属性、关系、动作视图。入参：{ name }" },
  { name: "search", description: "按文本检索相关的类名与关系名。入参：{ text }" },
];

export async function POST(req: Request) {
  const started = Date.now();
  try {
    const body = (await bodyJson(req)) as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (body.method === "tools/list") return NextResponse.json({ tools: TOOLS });
    if (body.method !== "tools/call") return NextResponse.json({ error: "只支持 tools/list 与 tools/call" }, { status: 400 });

    const name = body.params?.name;
    const args = body.params?.arguments ?? {};
    const config = loadConfig();
    const driver = demoDriver();

    if (name === "query") {
      const query = queryRequestSchema.parse(args.query);
      try {
        const { rows, path } = await runQuery(config, driver, query);
        safeLog(() => metaStore().logQuery({ version: getPublished().version, query_json: JSON.stringify(query), row_count: rows.length, ok: true, duration_ms: Date.now() - started }));
        return NextResponse.json({ content: { rows, path } });
      } catch (e) {
        safeLog(() => metaStore().logQuery({ version: getPublished().version, query_json: JSON.stringify(query), ok: false, error: e instanceof Error ? e.message : String(e), duration_ms: Date.now() - started }));
        throw e;
      }
    }
    if (name === "run_action") {
      const action = actionRequestSchema.parse(args);
      try {
        const result = await runAction(config, driver, action);
        safeLog(() => metaStore().logAction({
          version: getPublished().version,
          action: action.action,
          object_type: action.object,
          subject: String(action.identity),
          request_json: action.request ? JSON.stringify(action.request) : undefined,
          projections: result.projections,
          ok: result.ok,
          error: result.error,
          duration_ms: Date.now() - started,
        }));
        return NextResponse.json({ content: result });
      } catch (e) {
        safeLog(() => metaStore().logAction({
          version: getPublished().version,
          action: action.action,
          object_type: action.object,
          subject: String(action.identity),
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          duration_ms: Date.now() - started,
        }));
        throw e;
      }
    }
    if (name === "propose_ontology") {
      const tables = z.array(z.object({ connection: z.string(), table: z.string() })).parse(args.tables ?? []);
      const infos = await Promise.all(
        tables.map(async ({ connection, table }) => {
          const all = await driver.introspect(connection);
          const info = all.find((t) => t.name === table);
          if (!info) throw new EngineReject(`表不存在：${connection}.${table}`);
          return { connection, table: info };
        })
      );
      const draft = await getSlot().draftObjects(infos);
      return NextResponse.json({ content: { object_types: draft } });
    }
    if (name === "propose_action") {
      const clsName = String(args.object ?? "");
      const cls = config.object_types[clsName];
      if (!cls) throw new EngineReject(`配置中没有类：${clsName}`);
      // 有转化关系就给转化模板，否则给改属性模板；都是草稿，不发布
      const transition = Object.entries(config.link_types).find(([, l]) => l.from === clsName && l.to === clsName && l.transition);
      const draft = transition
        ? {
            description: `转化为${transition[1].transition!.to}`,
            pre: { [transition[1].transition!.property]: transition[1].transition!.from, $link: { [transition[0]]: false } },
            effect: [{ link: transition[0] }],
          }
        : {
            description: "更新属性（模板，请改属性名与前置）",
            pre: {},
            effect: [{ update: { object: clsName, identity: { from: "identity" }, properties: { 属性名: { from: "request" } } } }],
          };
      return NextResponse.json({ content: { action: draft } });
    }
    // 配置三视图：Agent 编请求前按它读，不写死名字（§5.3）
    if (name === "list_classes") return NextResponse.json({ content: { classes: listClasses(config) } });
    if (name === "read_class") return NextResponse.json({ content: readClass(config, String(args.name ?? "")) });
    if (name === "search") return NextResponse.json({ content: search(config, String(args.text ?? "")) });
    return NextResponse.json({ error: `未知工具：${name}` }, { status: 400 });
  } catch (e) {
    if (e instanceof ZodError) return NextResponse.json({ error: "入参形状不合法", issues: e.issues }, { status: 400 });
    if (e instanceof BadRequest) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof EngineReject) return NextResponse.json({ error: e.message }, { status: 422 });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
