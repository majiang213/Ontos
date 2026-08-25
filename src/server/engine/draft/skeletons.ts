// 动作骨架 —— 两类骨架的唯一构造点：set_fields（导入时每个新类自动补，含级联维护）与转化骨架（conversionAction，「阶段」裁决的产物）。
// actionSkeletonFor 也住这里：按类挑骨架是 MCP propose_action 的规则单源，要同时见两个构造点。
// 生成要模型、执行不要——set_fields 连模型也不用：形状固定，代码构造，过 set_action 同一份校验。

import type { ActionDef, LinkType, ObjectType, OntologyConfig } from "../../schema/config";
import { walkEffectItems } from "../../schema/spec/actionSpec";
import { EngineReject, MSG } from "../../errors";

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
  let found: Record<string, unknown> | undefined;
  walkEffectItems(cls.actions?.[FIELDS_UPDATE_ACTION], {
    update: (item) => {
      if (!found && item.object === clsName && item.properties) found = item.properties;
    },
  });
  return found;
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

/** 转化动作名的构造（唯一出处）：附录 B 保留字的命名规则，「阶段」裁决与骨架选择器都从这里取。 */
export function conversionActionName(to: string | number): string {
  return `convert_to_${to}`;
}

/** 转化动作骨架（唯一构造点）：前置 = 当前在早阶段 ∧ 还没转化过（$link false），效应 = 记一条转化关系。
 *  「阶段」裁决的产物与 MCP propose_action 的模板都走这里；附录 B 改骨架只动这一个函数。 */
export function conversionAction(linkName: string, link: LinkType): ActionDef {
  const t = link.transition!;
  return {
    description: `转化为${t.to}`,
    pre: { [t.property]: t.from, $link: { [linkName]: false } },
    effect: [{ link: linkName }],
  };
}

/** 按类挑动作骨架（MCP propose_action 的规则单源）：本类上有转化关系给转化模板（conversionAction），
 *  否则给 set_fields 骨架（与导入自动生成的同形同名，fieldsUpdateAction）；都是草稿，不发布。 */
export function actionSkeletonFor(config: OntologyConfig, clsName: string): { name: string; action: ActionDef } | { name: string; action: null; reason: string } {
  const cls = config.object_types[clsName];
  if (!cls) throw new EngineReject(MSG.classNotInConfig(clsName));
  const transition = Object.entries(config.link_types).find(([, l]) => l.from === clsName && l.to === clsName && l.transition);
  if (transition) return { name: conversionActionName(transition[1].transition!.to), action: conversionAction(transition[0], transition[1]) };
  const skel = fieldsUpdateAction(clsName, cls);
  return skel
    ? { name: FIELDS_UPDATE_ACTION, action: skel }
    : { name: FIELDS_UPDATE_ACTION, action: null, reason: "该类没有可写字段（唯一键与派生属性不可写）" };
}
