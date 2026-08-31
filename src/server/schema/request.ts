// 请求的 Zod schema —— 查询与写入对应《ontos-article.md》§5、§6，建稿判定对应对齐判定工作流。
// 这些形状同时用于：REST 路由入口校验、MCP 工具入参校验、模型结构化输出的约束。

import { z } from "zod";
import { MSG } from "../errors";
import { filterSchema, type Filter } from "./config";
import { Verdict } from "./verdict";

/* ---------- 查询：一棵以类为根的树 ---------- */
export const aggregateSchema = z.object({
  group_by: z.array(z.string()).default([]), // 空 = 全体合计（总数聚合的兜底口径：首选仍是列表查询数行数，真模型偶发空 group_by 时引擎按全体合计执行）；对错板对聚合按合计比对
  metrics: z
    .array(z.record(z.string(), z.string()).refine((m) => Object.keys(m).length === 1, { message: MSG.metricSingleKey }))
    .nonempty()
    .refine((ms) => new Set(ms.map((m) => Object.keys(m)[0])).size === ms.length, { message: MSG.metricDuplicate }), // [{ count: "*" }, { avg: "field" }]；指标名不许重复（下推按别名展开，重复别名 SQL 报错）
});
export type Aggregate = z.infer<typeof aggregateSchema>;

export interface ExpandNode {
  relation: string;
  properties?: string[];
  filter?: Filter;
  expand?: ExpandNode[];
}
export const expandNodeSchema: z.ZodType<ExpandNode> = z.lazy(() =>
  z.object({
    relation: z.string(),
    properties: z.array(z.string()).optional(),
    filter: filterSchema.optional(),
    expand: z.array(expandNodeSchema).optional(),
  })
);

export const queryRequestSchema = z.object({
  object: z.string(), // 起点：从哪个类查；仅根节点写
  identity: z.union([z.string(), z.number()]).optional(), // 认准一个体
  properties: z.array(z.string()).optional(),
  filter: filterSchema.optional(),
  order: z
    .record(z.string(), z.enum(["asc", "desc"]))
    .refine((o) => Object.keys(o).length === 1, { message: MSG.orderSingleKey })
    .optional(),
  limit: z.number().int().positive().max(1000).optional(), // 查询治理：上限
  aggregate: aggregateSchema.optional(), // 有它就不返回个体行
  expand: z.array(expandNodeSchema).optional(),
});
export type QueryRequest = z.infer<typeof queryRequestSchema>;

/* ---------- 写入：只点名 ---------- */
export const actionRequestSchema = z.object({
  action: z.string(), // 该类 actions 里已发布的一条
  object: z.string(),
  identity: z.union([z.string(), z.number()]),
  request: z.record(z.string(), z.unknown()).optional(), // 参数，如调拨的目标部门
});
export type ActionRequest = z.infer<typeof actionRequestSchema>;

/* ---------- 建稿判定：证据与结论（REST 路由与 MCP 工具共享形状，不双轨手写） ---------- */
export const proposeKeyRequestSchema = z.object({ object: z.string() });

export const overlapRequestSchema = z
  .object({ class_a: z.string(), class_b: z.string() })
  .refine((b) => b.class_a !== b.class_b, { message: MSG.pairSelfOverlap });

export const pairAdviceRequestSchema = z
  .object({
    class_a: z.string(),
    class_b: z.string(),
    rate: z.number().min(0).max(1),
    count_a: z.number().int().nonnegative(),
    count_b: z.number().int().nonnegative(),
    count_hit: z.number().int().nonnegative(),
  })
  .refine((b) => b.class_a !== b.class_b, { message: MSG.pairSelfAdvise });

// decided_by 不设默认：REST 入口填「画布操作者」，MCP 入口填「Agent（MCP）」——谁判定由入口声明
export const decideRequestSchema = z
  .object({
    class_a: z.string(),
    class_b: z.string(),
    verdict: z.enum(Verdict),
    stage_names: z.object({ from: z.string(), to: z.string() }).optional(),
    llm_advice: z.string().optional(),
    evidence: z
      .object({
        norm_rule: z.string().optional(),
        count_a: z.number().optional(),
        count_b: z.number().optional(),
        count_hit: z.number().optional(),
        rate: z.number().optional(),
        fields: z.record(z.string(), z.string()).optional(), // 命中的字段：每边用的唯一键属性名（compute_overlap 产出，原样回填）
      })
      .optional(),
    decided_by: z.string().optional(),
  })
  .refine((b) => b.class_a !== b.class_b, { message: MSG.pairSelfDecide });
export type DecideRequest = z.infer<typeof decideRequestSchema>;
