// MCP 工具注册表 —— 九个工具的名字、说明、inputSchema、space 与令牌闸、handler 全部只在这里登记一份。
// tools/list 与 tools/call 都读这张表；加/改工具只动这一个文件。
// inputSchema 一律从 zod 派生（z.toJSONSchema），不与运行期校验双轨手写。

import { z } from "zod";
import { actionRequestSchema, queryRequestSchema } from "@/server/schema/request";
import { affectedNames, mcpDraftOpSchema } from "@/server/schema/ops";
import type { OntologyConfig } from "@/server/schema/config";
import { query } from "@/server/engine/query/query";
import { runAction } from "@/server/engine/action/action";
import { EngineReject } from "@/server/errors";
import { conversionAction } from "@/server/engine/adjudication/adjudicate";
import { FIELDS_UPDATE_ACTION, fieldsUpdateAction } from "@/server/engine/config/skeletons";
import { getSlot } from "@/server/engine/llmSlot";
import { listClasses, listClassesDraft, readClass, readClassDraft, search } from "@/server/engine/config/views";
import { resolveTableInfos } from "@/server/engine/infra/load";
import type { DriverRegistry } from "@/server/engine/infra/registry";
import { applyDraft, getDraft, getPublished, getRev } from "@/server/engine/config/configStore";
import { metaStore } from "@/server/meta/store";
import { withActionLog, withQueryLog } from "@/server/engine/infra/logging";

/** 处理器上下文：空间、驱动、space 选择与取配置的两个入口。 */
export interface ToolContext {
  ws: string;
  driver: DriverRegistry;
  space: "published" | "draft";
  /** 按 space 取配置：published=已发布快照；draft=工作副本。 */
  config(): Promise<OntologyConfig>;
  /** 已发布快照（query/run_action 只读它；草稿视图拿它算状态对照）。 */
  published(): Promise<OntologyConfig>;
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

/** apply_draft 的信封：base_rev 必填数字（缺了、或 "12" 这种字符串都 -32602）；其余键原样留给 op 联合 parse。 */
const applyDraftEnvelope = z.looseObject({
  base_rev: z.number().int().nonnegative(),
});

/** apply_draft 的 inputSchema：op 联合由 mcpDraftOpSchema 派生（天然没有 save_*：摆位/弯折/钉点是界面状态），再并上必填的 base_rev。 */
const applyDraftInputSchema = {
  ...(z.toJSONSchema(mcpDraftOpSchema) as Record<string, unknown>),
  properties: { base_rev: { type: "integer", minimum: 0, description: "先 list_classes space=draft 拿到的 rev" } },
  required: ["base_rev"],
};

const json = (s: z.ZodType) => z.toJSONSchema(s) as Record<string, unknown>;

/** 顺序即 tools/list 顺序（测试钉死）：query → run_action → propose_* → 三个发现 → list_tables → apply_draft。 */
export const TOOLS: ToolDef[] = [
  {
    name: "query",
    description: "按已发布本体查业务数据（只读）。入参：{ query: 查询 JSON }。不接受 space。",
    inputSchema: json(z.object({ query: queryRequestSchema })),
    handler: async (ctx, args) => {
      const config = await ctx.published(); // 问数永远读已发布，不可改成草稿
      const parsed = queryRequestSchema.parse(args.query);
      const out = await withQueryLog(ctx.ws, { query_json: JSON.stringify(parsed) }, () => query(config, ctx.driver, parsed));
      return { payload: { rows: out.rows, path: out.path } };
    },
  },
  {
    name: "run_action",
    description: "执行一条已发布动作。入参：{ action, object, identity, request? }。不接受 space。",
    inputSchema: json(actionRequestSchema),
    auth: true,
    handler: async (ctx, args) => {
      const config = await ctx.published(); // 动作永远读已发布，不可改成草稿
      const action = actionRequestSchema.parse(args);
      const result = await withActionLog(ctx.ws, action, () => runAction(config, ctx.driver, action, { nextSequence: (k, s) => metaStore().nextSeq(ctx.ws, k, s) }));
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
      // 按连接分组内省 + 逐表定位：引擎共享实现（generate 同款）
      const infos = await resolveTableInfos(ctx.driver, tables, (m) => new EngineReject(m));
      const draft = await getSlot().proposeObjects(infos);
      return { payload: { object_types: draft } };
    },
  },
  {
    name: "propose_action",
    description: "对某个类产一条动作建议（不发布、不落到画布）。返回 { name, action }：name 是建议动作名，action 可直接作 set_action.def。入参：{ object, space? }。space 缺省 published（已发布）；草稿里尚未发布的类请传 draft。",
    inputSchema: json(z.object({ object: z.string(), space: spaceField })),
    space: true,
    handler: async (ctx, args) => {
      const config = await ctx.config(); // 只改变查找哪份配置，仍是一次出模板、不落地
      const clsName = String(args.object ?? "");
      const cls = config.object_types[clsName];
      if (!cls) throw new EngineReject(`配置中没有类：${clsName}`);
      // 有转化关系就给转化模板，否则给 set_fields 骨架（与导入自动生成的同形同名）；都是草稿，不发布
      const transition = Object.entries(config.link_types).find(([, l]) => l.from === clsName && l.to === clsName && l.transition);
      if (transition) return { payload: { name: `convert_to_${transition[1].transition!.to}`, action: conversionAction(transition[0], transition[1]) } }; // 转化骨架唯一构造点（adjudicate.ts）
      const skel = fieldsUpdateAction(clsName, cls); // set_fields 骨架唯一构造点（skeletons.ts）
      return { payload: skel ? { name: FIELDS_UPDATE_ACTION, action: skel } : { name: FIELDS_UPDATE_ACTION, action: null, reason: "该类没有可写字段（唯一键与派生属性不可写）" } };
    },
  },
  {
    name: "list_classes",
    description: "列出类的名字和说明。缺省看已发布；要看画布上还没发布的草稿，必须传 space: \"draft\"（返回里带 outlets——告知要发去的系统名列表）。入参：{ space? }。",
    inputSchema: json(z.object({ space: spaceField })),
    space: true,
    handler: async (ctx) => {
      if (ctx.space === "draft") {
        const state = await getDraft(ctx.ws);
        const published = await ctx.published();
        return {
          payload: {
            space: "draft",
            dirty: state.dirty,
            rev: getRev(ctx.ws),
            base_version: state.baseVersion,
            classes: listClassesDraft(state.draft, published),
            outlets: Object.keys(state.draft.outlets ?? {}), // 全局出站名（inform 的合法去向），只读——没有写入 op
          },
        };
      }
      return { payload: { classes: listClasses(await ctx.published()) } };
    },
  },
  {
    name: "read_class",
    description: "读一个类的字段、关系、动作。缺省已发布（不含来源表）。改画布请传 space: \"draft\"，会带上来源对照、能不能整份替换（replaceable）和完整动作定义（可读回-改-写回）。入参：{ name, space? }。",
    inputSchema: json(z.object({ name: z.string(), space: spaceField })),
    space: true,
    handler: async (ctx, args) => {
      const clsName = String(args.name ?? "");
      if (ctx.space === "draft") {
        const state = await getDraft(ctx.ws);
        return { payload: readClassDraft(state.draft, await ctx.published(), clsName) };
      }
      return { payload: readClass(await ctx.published(), clsName) };
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
    name: "list_tables",
    description: "列出已连接库里的表和列（只读列定义，没有采样行，不保存连接）。入参：{ connection? }。不接受 space。",
    inputSchema: json(z.object({ connection: z.string().optional() })),
    handler: async (ctx, args) => {
      // 只读列定义（不下发采样行）；按连接 try/catch，一个连接失败不让整个工具变成信封错误
      const conn = args.connection !== undefined ? String(args.connection) : undefined;
      if (conn !== undefined && !ctx.driver.has(conn)) {
        return { payload: { sources: [{ connection: conn, tables: [], error: "没有这个连接" }] } };
      }
      const sources = [];
      for (const connection of conn ? [conn] : ctx.driver.connectionNames()) {
        try {
          const tables = await ctx.driver.introspect(connection);
          sources.push({
            connection,
            tables: tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => ({ name: c.name, type: c.type, pk: c.pk })) })),
          });
        } catch {
          sources.push({ connection, tables: [], error: "连接失败或读取表结构失败" }); // 与 GET /api/list_tables 同口径：驱动内部主机/路径不出网
        }
      }
      return { payload: { sources } };
    },
  },
  {
    name: "apply_draft",
    description:
      "改草稿，一次只改一步。草稿还没发布，问数和已发布动作看不见。入参 { op, ... }，必带 base_rev（先 list_classes space=draft 拿 rev）。op 与草稿编辑同一套：创建/删除对象、增删字段、设认出同一对象靠的字段、创建/删除关系、导入对象、整份替换（未发布且未锁定的类）、设置/删除一条动作（set_action / remove_action）。不能发布、放弃、裁决、回滚；摆位、线的弯折和端点钉点是界面状态，也不归这里。不接受 space。",
    inputSchema: applyDraftInputSchema,
    auth: true,
    handler: async (ctx, args) => {
      const { base_rev, ...rest } = applyDraftEnvelope.parse(args); // 先剥信封再 parse op（判别联合不收信封字段）
      const op = mcpDraftOpSchema.parse(rest); // 无 save_layout；Zod 失败 -32602
      // 不在路由里比 getRev、不再套一层队列：base_rev 的比较在 applyDraft 的 enqueue task 开头
      const next = await applyDraft(op, ctx.ws, { base_rev });
      return { payload: { ok: true, dirty: next.dirty, rev: getRev(ctx.ws), base_version: next.baseVersion, op: op.op, names: affectedNames(op) } };
    },
  },
];
