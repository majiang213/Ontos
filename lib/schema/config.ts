// 本体配置的 Zod schema —— 对应《ontos-article.md》附录 B。
// 引擎只加载通过本校验的已发布配置。
// 结构校验在这里做；语义校验（属性名、关系名对得上配置）在引擎执行时做，对不上就拒绝。

import { z } from "zod";

/* ---------- 过滤 ----------
   查询的 filter、动作的 pre、布尔派生、when 下的过滤是同一个对象。
   直挂的键是属性名；关系条件收在 $link；pre 另多 $request、$exists。 */
export const literalSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type Literal = z.infer<typeof literalSchema>;

export const FILTER_OPS = ["eq", "ne", "lt", "lte", "gt", "gte", "in", "contains"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export type Filter = Record<string, unknown>;
export const filterSchema: z.ZodType<Filter> = z.record(z.string(), z.unknown());

/* ---------- 派生属性：两种形状 ----------
   列表：when 规则，谈源，从上到下取第一条命中。
   对象：一条过滤，取布尔。没有第三种专用键。 */
export const whenRuleSchema = z.object({
  when: z.record(z.string(), z.union([z.boolean(), filterSchema])),
  value: literalSchema,
});
export type WhenRule = z.infer<typeof whenRuleSchema>;
export const derivedSchema = z.union([z.array(whenRuleSchema).nonempty(), filterSchema]);
export type Derived = z.infer<typeof derivedSchema>;

/* ---------- 属性 ---------- */
export const generateItemSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);
export const propertySchema = z.object({
  type: z.enum(["string", "number", "boolean", "date", "enum"]),
  description: z.string().optional(),
  values: z.array(z.union([z.string(), z.number()])).optional(),
  derived: derivedSchema.optional(),
  generate: z.array(generateItemSchema).optional(),
});
export type PropertyDef = z.infer<typeof propertySchema>;

/* ---------- 源映射 ---------- */
export const sourceEntrySchema = z.object({
  connection: z.string(),
  table: z.string(),
  pk: z.string(),
  fields: z.record(z.string(), z.string()), // 源列属性 → 列名；派生属性不得出现
  key: z.string().optional(), // 该源用于对齐、认行的属性名；省略则用类的 identity
});
export type SourceEntry = z.infer<typeof sourceEntrySchema>;

/* ---------- 公理 ---------- */
export const axiomSchema = z.object({
  description: z.string().optional(),
  type: z.literal("mutex"), // 本期一种类型
  property: z.string(),
});
export type AxiomDef = z.infer<typeof axiomSchema>;

/* ---------- 动作 ---------- */
// 属性值来源：字面量 / 表达式字符串 / { from: ... } / { property, from }
export const valueSourceSchema = z.union([literalSchema, z.record(z.string(), z.unknown())]);
export type ValueSource = z.infer<typeof valueSourceSchema>;

export const effectItemSchema = z.union([
  z.object({
    update: z.object({
      object: z.string(),
      identity: valueSourceSchema.optional(),
      filter: filterSchema.optional(),
      properties: z.record(z.string(), valueSourceSchema),
    }),
  }),
  z.object({
    delete: z.object({
      object: z.string(),
      identity: valueSourceSchema.optional(),
      filter: filterSchema.optional(),
    }),
  }),
  z.object({
    create: z.object({
      object: z.string(),
      properties: z.record(z.string(), valueSourceSchema),
    }),
  }),
  z.object({ link: z.string() }), // 只用于转化关系；作用在请求点名的个体上
]);
export type EffectItem = z.infer<typeof effectItemSchema>;

export const informItemSchema = z.object({
  object: z.string(),
  to: z.array(z.string()),
  properties: z.record(z.string(), valueSourceSchema),
});
export const actionSchema = z.object({
  description: z.string().optional(),
  pre: filterSchema.optional(),
  effect: z.array(effectItemSchema).nonempty(),
  inform: z.array(informItemSchema).optional(),
});
export type ActionDef = z.infer<typeof actionSchema>;

/* ---------- 类 ---------- */
export const objectTypeSchema = z.object({
  description: z.string().optional(),
  kind: z.enum(["thing", "event"]),
  identity: z.string().optional(), // 同一性标准：一个源列属性的名
  properties: z.record(z.string(), propertySchema),
  sources: z.record(z.string(), sourceEntrySchema).optional(), // 键是源条目名
  axioms: z.record(z.string(), axiomSchema).optional(),
  actions: z.record(z.string(), actionSchema).optional(),
});
export type ObjectType = z.infer<typeof objectTypeSchema>;

/* ---------- 关系：match 与 transition 互斥 ---------- */
export const linkTypeSchema = z
  .object({
    description: z.string().optional(),
    from: z.string(),
    to: z.string(),
    inverse: z.string().optional(),
    card: z.string().optional(),
    match: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
    transition: z
      .object({
        property: z.string(),
        from: z.union([z.string(), z.number()]),
        to: z.union([z.string(), z.number()]),
      })
      .optional(),
  })
  .refine((l) => (l.match ? 1 : 0) + (l.transition ? 1 : 0) === 1, { message: "match 与 transition 必须且只能写一种" });
export type LinkType = z.infer<typeof linkTypeSchema>;

/* ---------- 根 ---------- */
export const outletSchema = z.object({
  description: z.string().optional(),
  connection: z.string(), // 收件地址，不是源表
});
export const configSchema = z.object({
  object_types: z.record(z.string(), objectTypeSchema),
  link_types: z.record(z.string(), linkTypeSchema).default({}),
  outlets: z.record(z.string(), outletSchema).optional(),
});
export type OntologyConfig = z.infer<typeof configSchema>;
