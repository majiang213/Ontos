// 对象卡动作区与画布监视器的纯函数：效应摘要（effectSummary）、表单兼容白名单（formCompatible）、轮询 toast 文案（externalToast）。
// 从组件抽出来单测；不依赖 React。规则见《外部Agent编辑画布.md》§6。

import type { ActionDef, OntologyConfig } from "../server/schema/config";
import { isFromOnly, isPlainLiteral } from "../server/schema/valueShape";

/** 效应摘要：一条效应一行白话，inform 另列。类名/属性名/关系名用配置里的机器名。
 *  不展示 from / 字面量 / filter / identity——同一属性换取值来源或字面量，摘要一行不变（摘要是给人看的告警，不是审计）。 */
export function effectSummary(def: ActionDef): string[] {
  const lines: string[] = [];
  for (const item of def.effect ?? []) {
    if ("update" in item) lines.push(`把 ${item.update.object} 的 ${Object.keys(item.update.properties).join("、")} 写成新值`);
    else if ("delete" in item) lines.push(`撤走 ${item.delete.object}`); // 毒性关卡底线：「撤走」一行不能省
    else if ("create" in item) lines.push(`新建 ${item.create.object}`);
    else if ("link" in item) lines.push(`转化 ${item.link}`);
  }
  for (const inf of def.inform ?? []) lines.push(`告知 ${inf.to.join("、")}（${inf.object}）`);
  return lines;
}

/** 表单认不认得出这条动作（认不出则对象卡只展示摘要、只许删——点「编辑」再保存不得把认不出的键丢掉）。
 *  白名单（附录 B 子集）：无 inform；pre 只含本类非派生字段的等于/不等于字面量、或 $link 已发生/未发生；
 *  update/delete 只作用在宿主类、无 filter、必须 identity: { from: identity }；create 取值只许 request/identity/字面量；
 *  link 只许本类上的转化关系。取值原语（isPlainLiteral/isFromOnly）来自 schema/valueShape。 */
export function formCompatible(def: ActionDef, clsName: string, config: Pick<OntologyConfig, "object_types" | "link_types">): boolean {
  const cls = config.object_types[clsName];
  if (!cls) return false;
  if (def.inform?.length) return false; // 告知本期表单不做
  for (const [k, v] of Object.entries(def.pre ?? {})) {
    if (k === "$link") {
      if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
      for (const sub of Object.values(v)) if (sub !== true && sub !== false) return false; // 嵌套过滤表单不认
      continue;
    }
    if (k.startsWith("$")) return false; // $request / $exists 表单不认
    const prop = cls.properties[k];
    if (!prop || prop.derived) return false; // 前置只能是本类非派生字段
    if (isPlainLiteral(v)) continue;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === "ne" && isPlainLiteral((v as Record<string, unknown>).ne)) continue;
    }
    return false;
  }
  for (const item of def.effect ?? []) {
    if ("update" in item) {
      const u = item.update;
      if (u.object !== clsName || u.filter || !isFromOnly(u.identity, "identity")) return false; // 附录 B：请求点名的那个体必须这样认人
      for (const [p, val] of Object.entries(u.properties)) {
        const prop = cls.properties[p];
        if (!prop || prop.derived) return false;
        if (!isPlainLiteral(val) && !isFromOnly(val, "request")) return false;
      }
      continue;
    }
    if ("delete" in item) {
      const del = item.delete;
      if (del.object !== clsName || del.filter || !isFromOnly(del.identity, "identity")) return false; // 跨类删除不算表单能编辑的
      continue;
    }
    if ("create" in item) {
      const c = item.create;
      const target = config.object_types[c.object];
      if (!target) return false;
      for (const [p, val] of Object.entries(c.properties)) {
        const prop = target.properties[p];
        if (!prop || prop.derived) return false;
        if (!isPlainLiteral(val) && !isFromOnly(val, "request") && !isFromOnly(val, "identity")) return false; // 不要表达式、不要 from: generated
      }
      continue;
    }
    if ("link" in item) {
      const l = config.link_types[item.link];
      if (!l?.transition || l.from !== clsName || l.to !== clsName) return false;
      continue;
    }
  }
  return true;
}

/** 轮询发现外部改动时的 toast 文案。判定顺序钉死：先动作差集与对象键差集的组合，再单对象键，最后默认句——
 *  禁止「对象键不变 → 默认句」把动作句做成死代码。 */
export interface MonitorFrame {
  object_types: Record<string, unknown>;
  action_changes?: { added: string[]; overwritten: string[]; removed: string[] };
}

export function externalToast(prev: MonitorFrame, next: MonitorFrame): string {
  const prevKeys = new Set(Object.keys(prev.object_types));
  const added = Object.keys(next.object_types).filter((k) => !prevKeys.has(k));
  const removed = [...prevKeys].filter((k) => !(k in next.object_types));
  const ac = next.action_changes ?? { added: [], overwritten: [], removed: [] };
  const actionNames = [...new Set([...ac.added, ...ac.overwritten, ...ac.removed])];
  const objPart =
    added.length && removed.length
      ? `新对象：${added.join("、")}；已去掉：${removed.join("、")}`
      : added.length
        ? `新对象：${added.join("、")}`
        : removed.length
          ? `已去掉：${removed.join("、")}`
          : "";
  const actPart = actionNames.length ? `动作有更新：${actionNames.join("、")}` : "";
  if (objPart && actPart) return `草稿有更新，已刷新（${objPart}；${actPart}）`;
  if (actPart) return `草稿有更新，已刷新（${actPart}）`;
  if (objPart) return `草稿有更新，已刷新（${objPart}）`;
  return "草稿有更新，已刷新";
}
