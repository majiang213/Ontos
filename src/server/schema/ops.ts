// 工作副本编辑操作的请求形状 —— /api/draft（REST 画布）与 MCP apply_draft 共用同一组判别联合。
// MCP 侧抽掉 save_layout / save_edge_bend / save_edge_pin（摆位/弯折/钉点是界面状态，Agent 不写）。

import { z } from "zod";
import { actionSchema, objectTypeSchema } from "./config";

/** 草稿路径的类体剥掉 actions / axioms：动作只走 set_action，公理本期没有写入 op。
 *  Zod 默认丢弃多余键——带进来不报错，但也不落地。派生字段（derived）保留（允许经导入进入新类）。 */
export const draftObjectSchema = objectTypeSchema.omit({ actions: true, axioms: true });

const createObjectOp = z.object({ op: z.literal("create_object"), name: z.string(), description: z.string().optional(), kind: z.enum(["thing", "event"]) });
const deleteObjectOp = z.object({ op: z.literal("delete_object"), name: z.string() });
const updateObjectOp = z.object({ op: z.literal("update_object"), name: z.string(), description: z.string().optional() });
const addPropertyOp = z.object({
  op: z.literal("add_property"),
  object: z.string(),
  name: z.string(),
  type: z.enum(["string", "number", "boolean", "date", "enum"]),
  description: z.string().optional(),
  values: z.array(z.union([z.string(), z.number()])).optional(),
});
const removePropertyOp = z.object({ op: z.literal("remove_property"), object: z.string(), name: z.string() });
// 改字段说明/类型/枚举值/改名（description 空串 = 清掉；改名前扫引用，被引用的属性拒改）
const updatePropertyOp = z.object({
  op: z.literal("update_property"),
  object: z.string(),
  name: z.string(),
  new_name: z.string().optional(),
  type: z.enum(["string", "number", "boolean", "date", "enum"]).optional(),
  values: z.array(z.union([z.string(), z.number()])).optional(),
  description: z.string().optional(),
});
const setIdentityOp = z.object({ op: z.literal("set_identity"), object: z.string(), name: z.string() }); // name 为空串 = 取消识别字段
const saveLayoutOp = z.object({ op: z.literal("save_layout"), positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })) });
// 线的弯折点：相对两端节点中心连线中点的偏移；bend=null 拉直。与摆位一样是界面状态
const saveEdgeBendOp = z.object({ op: z.literal("save_edge_bend"), name: z.string(), bend: z.object({ dx: z.number(), dy: z.number() }).nullable() });
// 手动连线：from 类 → to 类，必须给配对字段（match）——关系总得说清靠哪两个字段对上
const createLinkOp = z.object({
  op: z.literal("create_link"),
  name: z.string(),
  from: z.string(),
  to: z.string(),
  inverse: z.string().optional(),
  card: z.string().optional(),
  description: z.string().optional(),
  match: z.object({ from: z.string(), to: z.string() }),
});
const deleteLinkOp = z.object({ op: z.literal("delete_link"), name: z.string() });
// 关系改名/改反向名/改描述/改两端/改配对字段（画布拖边改接走 from/to：转化关系与被引用的关系拒改，配对字段跟新端点修）
const updateLinkOp = z.object({
  op: z.literal("update_link"),
  name: z.string(),
  new_name: z.string().optional(),
  description: z.string().optional(),
  inverse: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  match: z.object({ from: z.string(), to: z.string() }).optional(), // 单对配对，与 create_link 同形
});
// 逆向建模产物导入：整批对象进草稿（表结构抽屉多选 → 生成对象；MCP 侧是 propose_ontology 的落地点）
const importObjectsOp = z.object({ op: z.literal("import_objects"), objects: z.record(z.string(), z.unknown()) });
// 整份替换一个未锁定的类（def 是单个类体，不是整张 map）：锁定规则见 configStore.replaceBlockers
const replaceObjectOp = z.object({ op: z.literal("replace_object"), name: z.string(), def: draftObjectSchema });
// 动作写入（人和 Agent 同权）：def 过 actionSchema（附录 B 那份），与种子配置、conversionAction 同形；单条 upsert
const setActionOp = z.object({ op: z.literal("set_action"), object: z.string(), name: z.string(), def: actionSchema });
const removeActionOp = z.object({ op: z.literal("remove_action"), object: z.string(), name: z.string() });

export const draftOpSchema = z.discriminatedUnion("op", [
  createObjectOp,
  deleteObjectOp,
  updateObjectOp,
  addPropertyOp,
  removePropertyOp,
  updatePropertyOp,
  setIdentityOp,
  saveLayoutOp,
  saveEdgeBendOp,
  createLinkOp,
  deleteLinkOp,
  updateLinkOp,
  importObjectsOp,
  replaceObjectOp,
  setActionOp,
  removeActionOp,
]);
export type DraftOpInput = z.infer<typeof draftOpSchema>;

/** MCP apply_draft 的 op 联合：与 REST 共用同一组 variant，但抽掉 save_* 三个界面状态 op（Agent 不写摆位/弯折/钉点）。 */
export const mcpDraftOpSchema = z.discriminatedUnion("op", [
  createObjectOp,
  deleteObjectOp,
  updateObjectOp,
  addPropertyOp,
  removePropertyOp,
  updatePropertyOp,
  setIdentityOp,
  createLinkOp,
  deleteLinkOp,
  updateLinkOp,
  importObjectsOp,
  replaceObjectOp,
  setActionOp,
  removeActionOp,
]);

/** apply_draft 返回的 names：类名、关系名或「类名.动作名」（不收字段名）。画布 toast/发布条不读它，读 GET 的 action_changes。 */
export function affectedNames(op: DraftOpInput): string[] {
  switch (op.op) {
    case "create_object":
    case "delete_object":
    case "update_object":
    case "replace_object":
      return [op.name];
    case "update_link":
      return [op.new_name ?? op.name]; // 改名时给新名
    case "add_property":
    case "remove_property":
    case "set_identity":
    case "update_property":
      return [op.object]; // 这里的 object 是类名
    case "set_action":
    case "remove_action":
      return [`${op.object}.${op.name}`]; // 类名.动作名
    case "create_link":
    case "delete_link":
      return [op.name];
    case "import_objects":
      return Object.keys(op.objects);
    case "save_layout":
    case "save_edge_bend":
      return [];
  }
}
