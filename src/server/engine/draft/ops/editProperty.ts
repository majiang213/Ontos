// 删/改名字段 —— 不变量：引用不断链（referencesOf 全量扫，set_fields 的键跟随、不算断链），
// 唯一键指针跟随（改名跟走；直接删拒——先换一个）。remove_property / update_property 两条 op 住这里。

import type { OntologyConfig } from "../../../schema/config";
import { NAME_RE, type DraftOpInput as DraftOp } from "../../../schema/ops";
import { DraftReject } from "../../../errors";
import { referencesOf } from "../refs";
import { FIELDS_UPDATE_ACTION, removeFieldsUpdateKeys, renameFieldsUpdateKey } from "../skeletons";
import { mustType } from "./mustType";

type RemovePropertyOp = Extract<DraftOp, { op: "remove_property" }>;
type UpdatePropertyOp = Extract<DraftOp, { op: "update_property" }>;

/** set_fields 的键跟随、不当引用：扫描时就按结构排除（exceptAction），别的引用照拦——不拿报错文案当判据。 */
function blockingRefs(d: OntologyConfig, object: string, name: string): string[] {
  return referencesOf(d, object, name, { exceptAction: FIELDS_UPDATE_ACTION });
}

export function removeProperty(d: OntologyConfig, input: RemovePropertyOp): void {
  const t = mustType(d, input.object);
  if (!t.properties[input.name]) throw new DraftReject(`属性不存在：${input.name}`);
  if (t.identity === input.name) throw new DraftReject("唯一键不能直接删，先换一个");
  const refs = blockingRefs(d, input.object, input.name);
  if (refs.length) throw new DraftReject(`${input.name} 仍被引用：${refs.join("、")}`);
  delete t.properties[input.name];
  removeFieldsUpdateKeys(input.object, t, [input.name]); // set_fields 摘键（摘空整条撤掉），不当引用拦删除
}

export function updateProperty(d: OntologyConfig, input: UpdatePropertyOp): void {
  const t = mustType(d, input.object);
  const prop = t.properties[input.name];
  if (!prop) throw new DraftReject(`属性不存在：${input.name}`);
  if (input.description !== undefined) prop.description = input.description || undefined; // 空串 = 清掉
  if (input.type !== undefined && input.type !== prop.type) {
    prop.type = input.type;
    if (input.type !== "enum") delete prop.values; // 类型离开 enum，枚举值跟着清
  }
  if (input.values !== undefined) prop.values = input.values.length ? input.values : undefined; // 空数组 = 清掉
  if (input.new_name && input.new_name !== input.name) {
    if (!NAME_RE.test(input.new_name)) throw new DraftReject("属性名必须是小写字母/数字/下划线，字母开头");
    if (t.properties[input.new_name]) throw new DraftReject(`属性已存在：${input.new_name}`);
    const refs = blockingRefs(d, input.object, input.name);
    if (refs.length) throw new DraftReject(`${input.name} 仍被引用：${refs.join("、")}，先解除引用再改名`); // 被引用（源映射/关系/派生/动作）的属性改名会断链，拒；set_fields 的键跟随，不算断链
    t.properties[input.new_name] = prop;
    delete t.properties[input.name];
    if (t.identity === input.name) t.identity = input.new_name; // 唯一键指针跟着走
    renameFieldsUpdateKey(input.object, t, input.name, input.new_name); // set_fields 的 properties 键跟着走
  }
}
