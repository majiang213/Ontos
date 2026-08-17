// 工作副本编辑操作的请求形状 —— /api/draft 的入口校验。

import { z } from "zod";

export const draftOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create_object"), name: z.string(), description: z.string().optional(), kind: z.enum(["thing", "event"]) }),
  z.object({ op: z.literal("delete_object"), name: z.string() }),
  z.object({ op: z.literal("update_object"), name: z.string(), description: z.string().optional() }),
  z.object({
    op: z.literal("add_property"),
    object: z.string(),
    name: z.string(),
    type: z.enum(["string", "number", "boolean", "date", "enum"]),
    description: z.string().optional(),
    values: z.array(z.union([z.string(), z.number()])).optional(),
  }),
  z.object({ op: z.literal("remove_property"), object: z.string(), name: z.string() }),
  z.object({ op: z.literal("set_identity"), object: z.string(), name: z.string() }), // name 为空串 = 取消识别字段
  z.object({ op: z.literal("save_layout"), positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })) }),
  // 逆向建模产物导入：整批对象进草稿（表结构抽屉多选 → 生成对象）
  z.object({ op: z.literal("import_objects"), objects: z.record(z.string(), z.unknown()) }),
]);
export type DraftOpInput = z.infer<typeof draftOpSchema>;
