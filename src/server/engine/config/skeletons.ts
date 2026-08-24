// 动作骨架：set_fields 的唯一构造点与级联维护。
// 转化骨架（conversionAction）在 adjudicate.ts；这里管导入时每个新类自动补的「更新字段」。
// 生成要模型、执行不要——这条动作连模型也不用：形状固定，代码构造，过 set_action 同一份校验。

import type { ActionDef, ObjectType } from "../schema/config";

/** 固定动作名：调用方（run_action）、文档、测试都引它，不让模型起名。 */
export const FIELDS_UPDATE_ACTION = "set_fields";

/** set_fields 骨架：按 identity 认人，把请求值写进可写字段（唯一键与派生属性不可写）。
 *  无可写字段返回 null——update.properties 不能为空（空 SET 不是合法 SQL），不生成死动作。 */
export function fieldsUpdateAction(clsName: string, cls: ObjectType): ActionDef | null {
  const writable = Object.keys(cls.properties).filter((p) => p !== cls.identity && !cls.properties[p].derived);
  if (writable.length === 0) return null;
  return {
    description: "更新字段（导入时自动生成）",
    pre: {},
    effect: [
      {
        update: {
          object: clsName,
          identity: { from: "identity" },
          properties: Object.fromEntries(writable.map((p) => [p, { from: "request" }])),
        },
      },
    ],
  };
}

/** 取 set_fields 效应里指向本类的 update.properties；动作不存在或形状不符返回 undefined。 */
function writablePropsOf(clsName: string, cls: ObjectType): Record<string, unknown> | undefined {
  for (const item of cls.actions?.[FIELDS_UPDATE_ACTION]?.effect ?? []) {
    if ("update" in item && item.update.object === clsName && item.update.properties) return item.update.properties;
  }
  return undefined;
}

/** 字段改名跟随：set_fields 的 properties 键换名（与唯一键指针跟随同一条规矩）。 */
export function renameFieldsUpdateKey(clsName: string, cls: ObjectType, oldName: string, newName: string): void {
  const props = writablePropsOf(clsName, cls);
  if (!props || !(oldName in props)) return;
  props[newName] = props[oldName];
  delete props[oldName];
}

/** 摘键：字段删除、部分重叠上移时调用。摘空了整条动作撤掉（空 properties 过不了 actionSchema）。 */
export function removeFieldsUpdateKeys(clsName: string, cls: ObjectType, names: string[]): void {
  const props = writablePropsOf(clsName, cls);
  if (!props) return;
  for (const n of names) delete props[n];
  if (Object.keys(props).length === 0) {
    delete cls.actions![FIELDS_UPDATE_ACTION];
    if (Object.keys(cls.actions!).length === 0) delete cls.actions; // 空 map 会让 dirty 收不回来，删干净
  }
}
