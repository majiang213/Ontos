// 整批导入 —— 不变量：原子。先全量预检再一次落草稿，循环里半途抛错不会留下前几个类（孤儿对象会随下次发布混出去）；
// 落笔即带 set_fields 骨架（骨架唯一构造点在 skeletons；无可写字段的类不补）。

import type { OntologyConfig } from "../../../schema/config";
import { draftObjectSchema, NAME_RE, type DraftOpInput as DraftOp } from "../../../schema/ops";
import { DraftReject } from "../../../errors";
import { FIELDS_UPDATE_ACTION, fieldsUpdateAction } from "../skeletons";

type ImportObjectsOp = Extract<DraftOp, { op: "import_objects" }>;

export function importObjects(d: OntologyConfig, input: ImportObjectsOp): void {
  const staged: [string, OntologyConfig["object_types"][string]][] = [];
  for (const [name, raw] of Object.entries(input.objects)) {
    if (!NAME_RE.test(name)) throw new DraftReject(`类名必须是小写字母/数字/下划线，字母开头：${name}`);
    if (d.object_types[name]) throw new DraftReject(`类已存在：${name}`);
    staged.push([name, draftObjectSchema.parse(raw)]); // 逐类过结构校验；草稿路径剥掉 actions/axioms（动作只走 set_action）
  }
  for (const [name, obj] of staged) {
    d.object_types[name] = obj;
    const skel = fieldsUpdateAction(name, obj); // 导入即带 set_fields（骨架唯一构造点）；无可写字段的类不补
    if (skel) d.object_types[name].actions = { [FIELDS_UPDATE_ACTION]: skel };
  }
}
