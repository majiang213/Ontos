// MCP 工具注册表 —— 十个工具的名字、说明、inputSchema、space 与令牌闸、handler 全部只在这里登记一份。
// tools/list 与 tools/call 都读这张表；加/改工具只动这一个文件。
// inputSchema 一律从 zod 派生（z.toJSONSchema），不与运行期校验双轨手写。

import { z } from "zod";
import { actionRequestSchema, queryRequestSchema } from "@/server/schema/request";
import { affectedNames, mcpDraftOpSchema } from "@/server/schema/ops";
import type { OntologyConfig } from "@/server/schema/config";
import type { EngineEnv } from "@/server/features/env";
import { query } from "@/server/features/query/query";
import { runAction } from "@/server/features/action/action";
import { DraftReject, EngineReject } from "@/server/errors";
import { actionSkeletonFor } from "@/server/features/ontology/skeletons";
import { proposeObjectsFor } from "@/server/infra/llm/slot";
import { listCandidates } from "@/server/features/integrate/candidates";
import { draftClassesPayload, listClasses, readClass, readClassDraft, search } from "@/server/features/ontology/views";
import { listTables } from "@/server/infra/tables";
import type { DriverRegistry } from "@/server/infra/registry";
import { editDraft } from "@/server/features/ontology/editDraft";
import { getRev } from "@/server/features/ontology/current";
import type { DraftState } from "@/server/features/ontology/canvasPack";
import { withActionLog, withQueryLog } from "@/server/infra/trail";

/** 处理器上下文：空间、驱动、引擎依赖、space 选择与取配置的入口。工具层的依赖面就是这张表——handler 不绕过它直取 draft 包。 */
export interface ToolContext {
  workspace: string;
  /** 引擎依赖（组合根组装，路由/本层只下传）：handler 需要 meta / 槽位 / 时钟时从这里拿。 */
  env: EngineEnv;
  driver: DriverRegistry;
  space: "published" | "draft";
  /** 按 space 取配置：published=已发布快照；draft=工作副本。 */
  config(): Promise<OntologyConfig>;
  /** 已发布快照（query/run_action 只读它；草稿视图拿它算状态对照）。返回 { config, version }——留痕盖版本号由调用方取。 */
  published(): Promise<{ config: OntologyConfig; version: number }>;
  /** 草稿视图整包：工作副本状态 + rev + 已发布（draft 分支三件套，config()/published() 盖不住它）。 */
  draftView(): Promise<{ state: DraftState; rev: number; published: OntologyConfig }>;
}

export interface ToolResult {
  payload: unknown;
  isError?: boolean; // 业务失败（前置不满足等），信封仍是 result
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** true = 接受可选 space（published|draft，缺省 published）；否则 arguments 带 space 键即 -32602。 */
  space?: boolean;
  /** true = 写工具：先过 requireWriteAuth（未授权 -32001）。 */
  auth?: boolean;
  handler(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

const spaceField = z.enum(["published", "draft"]).optional();

/** edit_draft 的信封：base_rev 必填数字（缺了、或 "12" 这种字符串都 -32602）；其余键原样留给 op 联合 parse。 */
const editDraftEnvelope = z.looseObject({
  base_rev: z.number().int().nonnegative(),
});

/** edit_draft 的 inputSchema：op 联合由 mcpDraftOpSchema 派生（天然没有 save_*：摆位/弯折/钉点是界面状态），再并上必填的 base_rev。 */
const editDraftInputSchema = {
  ...(z.toJSONSchema(mcpDraftOpSchema) as Record<string, unknown>),
  properties: { base_rev: { type: "integer", minimum: 0, description: "先 list_classes space=draft 拿到的 rev" } },
  required: ["base_rev"],
};

const json = (s: z.ZodType) => z.toJSONSchema(s) as Record<string, unknown>;

/** 顺序即 tools/list 顺序（测试钉死）：query → run_action → propose_* → 发现 → list_candidates → list_tables → edit_draft。 */
export const TOOLS: ToolDef[] = [
  {
    name: "query",
    description: "按已发布本体查业务数据（只读）。入参：{ query: 查询 JSON }。不接受 space。",
    inputSchema: json(z.object({ query: queryRequestSchema })),
    handler: async (ctx, args) => {
      const { config, version } = await ctx.published(); // 问数永远读已发布，不可改成草稿
      const parsed = queryRequestSchema.parse(args.query);
      const r = await withQueryLog({ meta: ctx.env.meta, clock: ctx.env.clock }, ctx.workspace, version, { query_json: JSON.stringify(parsed) }, () => query(ctx.env, config, ctx.driver, parsed));
      if (r.code !== 200) throw new EngineReject(r.message); // 域拒绝经 Result 返回，按 MCP 约定转 -32000（route 的 catch 接）
      return { payload: { rows: r.value.rows, path: r.value.path } };
    },
  },
  {
    name: "run_action",
    description: "执行一条已发布动作。入参：{ action, object, identity, request? }。不接受 space。",
    inputSchema: json(actionRequestSchema),
    auth: true,
    handler: async (ctx, args) => {
      const { config, version } = await ctx.published(); // 动作永远读已发布，不可改成草稿
      const action = actionRequestSchema.parse(args);
      const result = await withActionLog({ meta: ctx.env.meta, clock: ctx.env.clock }, ctx.workspace, version, action, () => runAction(ctx.env, config, ctx.driver, action));
      // 业务失败（前置/公理/投影）按 MCP 约定标 isError，调用方不用猜
      return { payload: result, isError: !result.ok };
    },
  },
  {
    name: "propose_objects",
    description: "对选中的表产对象建议（不落到画布）。入参：{ tables: [{ connection, table }] }。不接受 space。",
    inputSchema: json(z.object({ tables: z.array(z.object({ connection: z.string(), table: z.string() })).nonempty() })),
    handler: async (ctx, args) => {
      const tables = z.array(z.object({ connection: z.string(), table: z.string() })).nonempty().parse(args.tables ?? []);
      // 按连接分组内省 + 逐表定位 + 槽位产草稿：组合原语（llm/slot.proposeObjectsFor，REST 同款）
      const r = await proposeObjectsFor(ctx.env.llm, ctx.driver, tables, (m) => new EngineReject(m));
      if (r.code !== 200) throw new EngineReject(r.message); // 域拒绝经 Result 返回，按 MCP 约定转 -32000（route 的 catch 接）
      return { payload: { object_types: r.value } };
    },
  },
  {
    name: "propose_action",
    description: "对某个类产一条动作建议（不发布、不落到画布）。返回 { name, action }：name 是建议动作名，action 可直接作 set_action.def。入参：{ object, space? }。space 缺省 published（已发布）；草稿里尚未发布的类请传 draft。",
    inputSchema: json(z.object({ object: z.string(), space: spaceField })),
    space: true,
    handler: async (ctx, args) => {
      const config = await ctx.config(); // 只改变查找哪份配置，仍是一次出模板、不落地
      // 骨架选择规则在 engine（draft/skeletons.actionSkeletonFor）：转化模板 / set_fields 骨架的构造点也都归 engine
      return { payload: actionSkeletonFor(config, String(args.object ?? "")) };
    },
  },
  {
    name: "list_classes",
    description: "列出类的名字和说明。缺省看已发布；要看画布上还没发布的草稿，必须传 space: \"draft\"（返回里带 outlets、每个类已定的唯一键字段名 identity）。入参：{ space? }。",
    inputSchema: json(z.object({ space: spaceField })),
    space: true,
    handler: async (ctx) => {
      if (ctx.space === "draft") {
        const { state, rev, published } = await ctx.draftView();
        // payload 形状在 engine（views.draftClassesPayload 纯函数）；这里只剩取数
        return { payload: draftClassesPayload(state, published, rev) };
      }
      return { payload: { classes: listClasses((await ctx.published()).config) } };
    },
  },
  {
    name: "read_class",
    description: "读一个类的字段、关系、动作，以及该类参与的类与类结论（部分重叠由来、同形异义）。缺省已发布（不含来源表）。改画布请传 space: \"draft\"，会带上来源对照、能不能整份替换（replaceable）和完整动作定义（可读回-改-写回）。入参：{ name, space? }。",
    inputSchema: json(z.object({ name: z.string(), space: spaceField })),
    space: true,
    handler: async (ctx, args) => {
      const clsName = String(args.name ?? "");
      if (ctx.space === "draft") {
        const { state, published } = await ctx.draftView();
        return { payload: readClassDraft(state.draft, published, clsName) };
      }
      return { payload: readClass((await ctx.published()).config, clsName) };
    },
  },
  {
    name: "search",
    description: "按文本找类名、关系名。缺省已发布；找草稿里的名字请传 space: \"draft\"。入参：{ text, space? }。",
    inputSchema: json(z.object({ text: z.string(), space: spaceField })),
    space: true,
    handler: async (ctx, args) => ({ payload: search(await ctx.config(), String(args.text ?? "")) }),
  },
  {
    name: "list_candidates",
    description: "列出草稿里等着人裁的疑似重复（只看、不定案）。每条带两个类名、机器倾向和一句依据。入参无。不接受 space。",
    inputSchema: json(z.object({})),
    handler: async (ctx) => {
      const r = await listCandidates(ctx.env, ctx.workspace);
      if (r.code !== 200) throw new EngineReject(r.message);
      return { payload: { candidates: r.value } };
    },
  },
  {
    name: "list_tables",
    description: "列出已连接库里的表和列（只读列定义，没有采样行，不保存连接）。入参：{ connection? }。不接受 space。",
    inputSchema: json(z.object({ connection: z.string().optional() })),
    handler: async (ctx, args) => {
      // 只读列定义（不下发采样行）；逐连接降级在引擎原语里（infra/tables.listTables，与 REST 同口径）
      const conn = args.connection !== undefined ? String(args.connection) : undefined;
      const sources = (await listTables(ctx.driver, { connection: conn })).map((s) =>
        s.error ? s : { connection: s.connection, tables: s.tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => ({ name: c.name, type: c.type, pk: c.pk })) })) }
      );
      return { payload: { sources } };
    },
  },
  {
    name: "edit_draft",
    description:
      "改草稿，一次只改一步。草稿还没发布，问数和已发布动作看不见。入参 { op, ... }，必带 base_rev（先 list_classes space=draft 拿 rev）。op 与草稿编辑同一套：创建/删除对象、增删字段、设认出同一对象靠的字段、创建/删除关系、导入对象、整份替换（未发布且未锁定的类）、设置/删除一条动作（set_action / remove_action）。不能发布、放弃、裁决、回滚；摆位、线的弯折和端点钉点是界面状态，也不归这里。不接受 space。",
    inputSchema: editDraftInputSchema,
    auth: true,
    handler: async (ctx, args) => {
      const { base_rev, ...rest } = editDraftEnvelope.parse(args); // 先剥信封再 parse op（判别联合不收信封字段）
      const op = mcpDraftOpSchema.parse(rest); // 无 save_layout；Zod 失败 -32602
      // 不在路由里比 getRev：base_rev 的比对在 editDraft 内并入 rev CAS（冲突即 422）
      const r = await editDraft(ctx.env, op, ctx.workspace, { base_rev });
      if (r.code !== 200) throw new DraftReject(r.message); // 域拒绝经 Result 返回，按 MCP 约定转 -32000（route 的 catch 接）
      const next = r.value;
      return { payload: { ok: true, dirty: next.dirty, rev: await getRev(ctx.env, ctx.workspace), base_version: next.baseVersion, op: op.op, names: affectedNames(op) } };
    },
  },
];
