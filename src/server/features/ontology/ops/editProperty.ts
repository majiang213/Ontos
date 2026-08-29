// 删/改名字段 —— 不变量：引用不断链（referencesOf 全量扫，set_fields 的键跟随、不算断链），
// 唯一键指针跟随（改名跟走；直接删拒——先换一个）。remove_property / update_property 两条 op 住这里。
// 源对照跟随：删/改名先动本类 sources.*.fields（改名时源条目 key 跟走），对照本身不再单独挡删/改名——
// 画布没有拉列入口，对照补不回来；公理/关系配对/派生/动作的引用仍拦。
// 先动 fields 再扫引用：拦截失败靠 editDraft 的整份回退（backup）不留半截，本文件不手工改回。

import type { ObjectType, OntologyConfig } from "../../../schema/config";
import { enumValueKey, enumValueLabel } from "../../../schema/config";
import { NAME_RE, type DraftOpInput as DraftOp } from "../../../schema/ops";
import { DraftReject, MSG } from "../../../errors";
import { referencesOf } from "../refs";
import { FIELDS_UPDATE_ACTION, removeFieldsUpdateKeys, renameFieldsUpdateKey } from "../skeletons";
import { mustClass } from "./classMustExist";

type RemovePropertyOp = Extract<DraftOp, { op: "remove_property" }>;
type UpdatePropertyOp = Extract<DraftOp, { op: "update_property" }>;

/** set_fields 的键跟随、不当引用：扫描时就按结构排除（exceptAction），别的引用照拦——不拿报错文案当判据。 */
function blockingRefs(d: OntologyConfig, object: string, name: string): string[] {
  return referencesOf(d, object, name, { exceptAction: FIELDS_UPDATE_ACTION });
}

/** 删掉本类每一条源条目的 fields[prop]（源条目 key 指向它不跟删——认行依据缺口由落定校验拦住并整体回退）。 */
function stripSourceFields(t: ObjectType, prop: string): void {
  for (const e of Object.values(t.sources ?? {})) {
    if (e.fields[prop]) delete e.fields[prop];
  }
}

/** 本类每一条源条目的 fields 旧键换新键；源条目 key 指向旧名时跟着走（对齐属性换名，对照不断）。 */
function renameSourceFields(t: ObjectType, oldName: string, newName: string): void {
  for (const e of Object.values(t.sources ?? {})) {
    if (e.fields[oldName]) {
      e.fields[newName] = e.fields[oldName];
      delete e.fields[oldName];
    }
    if (e.key === oldName) e.key = newName;
  }
}

export function removeProperty(d: OntologyConfig, input: RemovePropertyOp): void {
  const t = mustClass(d, input.object);
  if (!t.properties[input.name]) throw new DraftReject(MSG.propNotFound(input.name));
  if (t.identity === input.name) throw new DraftReject(MSG.propIdentityNoDelete);
  stripSourceFields(t, input.name); // 先摘本类源对照：对照了列的字段也能删（画布 ✕ 的语义就是「不要这个字段」）
  const refs = blockingRefs(d, input.object, input.name);
  if (refs.length) throw new DraftReject(MSG.stillReferenced(input.name, refs)); // 公理/关系/派生/动作仍拦；editDraft 回退后 fields 旧键还在
  delete t.properties[input.name];
  removeFieldsUpdateKeys(input.object, t, [input.name]); // set_fields 摘键（摘空整条撤掉），不当引用拦删除
}

export function updateProperty(d: OntologyConfig, input: UpdatePropertyOp): void {
  const t = mustClass(d, input.object);
  const prop = t.properties[input.name];
  if (!prop) throw new DraftReject(MSG.propNotFound(input.name));
  if (input.description !== undefined) prop.description = input.description || undefined; // 空串 = 清掉
  if (input.type !== undefined && input.type !== prop.type) {
    prop.type = input.type;
    if (input.type !== "enum") delete prop.values; // 类型离开 enum，枚举值跟着清
  }
  if (input.values !== undefined) {
    // 换枚举值列表时按 key 保留已有中文名（操作数的 values 只谈 key；中文名由阶段页管理，这里不丢）
    const labels = new Map((prop.values ?? []).map((v) => [String(enumValueKey(v)), enumValueLabel(v)]));
    prop.values = input.values.length
      ? input.values.map((v) => {
          const label = labels.get(String(v));
          return label ? { value: v, label } : v;
        })
      : undefined; // 空数组 = 清掉
  }
  if (input.new_name && input.new_name !== input.name) {
    if (!NAME_RE.test(input.new_name)) throw new DraftReject(MSG.propNameBad);
    if (t.properties[input.new_name]) throw new DraftReject(MSG.propExists(input.new_name));
    renameSourceFields(t, input.name, input.new_name); // 先改写本类 fields/key：改名 = 字段换个名字，对照跟着走
    const refs = blockingRefs(d, input.object, input.name);
    if (refs.length) throw new DraftReject(MSG.propStillReferencedRename(input.name, refs)); // 被引用（关系/派生/动作）的属性改名会断链，拒；editDraft 回退后 fields 仍是旧键
    t.properties[input.new_name] = prop;
    delete t.properties[input.name];
    if (t.identity === input.name) t.identity = input.new_name; // 唯一键指针跟着走
    renameFieldsUpdateKey(input.object, t, input.name, input.new_name); // set_fields 的 properties 键跟着走
  }
}
