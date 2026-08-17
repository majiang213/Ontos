// 查询与写入请求的 Zod schema —— 对应《ontos-article.md》§5、§6。
// 这两个形状同时用于：路由入口校验、generateObject 的输出约束。

import { z } from "zod";
import { filterSchema, type Filter } from "./config";

/* ---------- 查询：一棵以类为根的树 ---------- */
export const aggregateSchema = z.object({
  group_by: z.array(z.string()).nonempty(),
  metrics: z.array(z.record(z.string(), z.string())).nonempty(), // [{ count: "*" }, { avg: "field" }]
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
  order: z.record(z.string(), z.enum(["asc", "desc"])).optional(),
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
