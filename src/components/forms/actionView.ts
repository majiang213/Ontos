// 对象卡动作区与画布监视器的纯函数：效应摘要（effectSummary）、表单兼容白名单（formCompatible）、轮询 toast 文案（externalToast）、
// 动作表单往返（prefillPre/prefillEff/buildActionDef，从 forms.tsx 抽出来单测）。
// 不依赖 React。规则见《外部Agent编辑画布.md》§6。

import type { ActionDef, OntologyConfig } from "../../server/schema/config";
import { isFromOnly } from "../../server/schema/spec/valueSpec";
import { formPreOk, formValueKind, inFormSubset } from "../../server/schema/spec/actionSpec";

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
 *  link 只许本类上的转化关系。取值形状的判定查 schema/spec/actionSpec 的 FORM_SUBSET，不在这里另写一份。 */
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
    if (!formPreOk(v)) return false; // 等于/不等于字面量
  }
  for (const item of def.effect ?? []) {
    if ("update" in item) {
      const u = item.update;
      if (u.object !== clsName || u.filter || formValueKind(u.identity) !== "from:identity") return false; // 附录 B：请求点名的那个体必须这样认人
      for (const [p, val] of Object.entries(u.properties)) {
        const prop = cls.properties[p];
        if (!prop || prop.derived) return false;
        if (!inFormSubset("effect.update.properties", val)) return false;
      }
      continue;
    }
    if ("delete" in item) {
      const del = item.delete;
      if (del.object !== clsName || del.filter || formValueKind(del.identity) !== "from:identity") return false; // 跨类删除不算表单能编辑的
      continue;
    }
    if ("create" in item) {
      const c = item.create;
      const target = config.object_types[c.object];
      if (!target) return false;
      for (const [p, val] of Object.entries(c.properties)) {
        const prop = target.properties[p];
        if (!prop || prop.derived) return false;
        if (!inFormSubset("effect.create.properties", val)) return false; // 不要表达式、不要 from: generated
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

/* ---------- 动作表单往返（prefill / buildActionDef） ----------
   白名单（formCompatible）放行的动作必须能逐键往返：def → 表单行 → def。
   行类型是表单交互的模型；buildActionDef 拼出的形状就是 FORM_SUBSET 认得的那套（schema/spec/actionSpec）。
   已知边界：字面值经文本框往返，形似数字/布尔/null 的字符串会被改写类型（演示域不含这类值）。 */

export type PreRow =
  | { kind: "prop"; prop: string; op: "eq" | "ne"; value: string }
  | { kind: "link"; link: string; happened: boolean };

export type PropVal = { prop: string; source: "request" | "identity" | "literal"; value: string };

export type EffRow =
  | { kind: "update"; rows: PropVal[] } // 把字段写成某值（作用在请求点名的那个体上）
  | { kind: "link"; link: string } // 转化
  | { kind: "create"; object: string; rows: PropVal[] } // 新生一个对象
  | { kind: "delete" }; // 撤走这个对象

/** 值输入框里的文本 → 字面量：true/false/null/数字各归各位，其余当字符串。 */
export function parseLiteral(s: string): unknown {
  const t = s.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (t !== "" && !Number.isNaN(Number(t))) return Number(t);
  return t;
}

export function prefillPre(def: Pick<ActionDef, "pre"> | undefined): PreRow[] {
  const rows: PreRow[] = [];
  for (const [k, v] of Object.entries(def?.pre ?? {})) {
    if (k === "$link") {
      for (const [ln, b] of Object.entries(v as Record<string, unknown>)) rows.push({ kind: "link", link: ln, happened: b === true });
    } else if (v !== null && typeof v === "object" && "ne" in (v as Record<string, unknown>)) {
      rows.push({ kind: "prop", prop: k, op: "ne", value: String((v as Record<string, unknown>).ne) });
    } else {
      rows.push({ kind: "prop", prop: k, op: "eq", value: String(v) });
    }
  }
  return rows;
}

function prefillVal(v: unknown): Pick<PropVal, "source" | "value"> {
  if (isFromOnly(v, "request")) return { source: "request", value: "" };
  if (isFromOnly(v, "identity")) return { source: "identity", value: "" };
  return { source: "literal", value: String(v) };
}

export function prefillEff(def: Pick<ActionDef, "effect"> | undefined): EffRow[] | undefined {
  if (!def) return undefined;
  const rows: EffRow[] = [];
  for (const item of def.effect ?? []) {
    if ("update" in item) {
      rows.push({ kind: "update", rows: Object.entries(item.update.properties).map(([p, v]) => ({ prop: p, ...prefillVal(v) })) });
    } else if ("link" in item) {
      rows.push({ kind: "link", link: item.link });
    } else if ("create" in item) {
      rows.push({ kind: "create", object: item.create.object, rows: Object.entries(item.create.properties).map(([p, v]) => ({ prop: p, ...prefillVal(v) })) });
    } else if ("delete" in item) {
      rows.push({ kind: "delete" });
    }
  }
  return rows;
}

/** 拼 def（附录 B 形状）；缺必填项返回 { ok: false, error } 由表单显示。 */
export function buildActionDef(input: { clsName: string; name: string; description: string; preRows: PreRow[]; effRows: EffRow[] }): { ok: true; def: Record<string, unknown> } | { ok: false; error: string } {
  const { clsName, name, description, preRows, effRows } = input;
  if (!/^[a-z][a-z0-9_]*$/.test(name.trim())) return { ok: false, error: "名字必须是小写字母/数字/下划线，字母开头" };
  const pre: Record<string, unknown> = {};
  for (const r of preRows) {
    if (r.kind === "prop") {
      if (!r.prop) return { ok: false, error: "前置里有一行没选字段" };
      pre[r.prop] = r.op === "eq" ? parseLiteral(r.value) : { ne: parseLiteral(r.value) };
    } else {
      if (!r.link) return { ok: false, error: "前置里有一行没选关系" };
      pre.$link = { ...((pre.$link as Record<string, unknown>) ?? {}), [r.link]: r.happened };
    }
  }
  const effect: Record<string, unknown>[] = [];
  for (const r of effRows) {
    if (r.kind === "update") {
      const properties: Record<string, unknown> = {};
      for (const p of r.rows) {
        if (!p.prop) return { ok: false, error: "「把字段写成某值」里有一行没选字段" };
        properties[p.prop] = p.source === "request" ? { from: "request" } : parseLiteral(p.value);
      }
      if (Object.keys(properties).length === 0) return { ok: false, error: "「把字段写成某值」至少选一行字段" };
      effect.push({ update: { object: clsName, identity: { from: "identity" }, properties } });
    } else if (r.kind === "link") {
      if (!r.link) return { ok: false, error: "「转化」没选关系" };
      effect.push({ link: r.link });
    } else if (r.kind === "create") {
      if (!r.object) return { ok: false, error: "「新生一个对象」没选对象" };
      const properties: Record<string, unknown> = {};
      for (const p of r.rows) {
        if (!p.prop) return { ok: false, error: "「新生一个对象」里有一行没选字段" };
        properties[p.prop] = p.source === "request" ? { from: "request" } : p.source === "identity" ? { from: "identity" } : parseLiteral(p.value);
      }
      if (Object.keys(properties).length === 0) return { ok: false, error: "「新生一个对象」至少填一行字段" };
      effect.push({ create: { object: r.object, properties } });
    } else {
      effect.push({ delete: { object: clsName, identity: { from: "identity" } } });
    }
  }
  if (effect.length === 0) return { ok: false, error: "「做完会」至少要有一条" };
  return {
    ok: true,
    def: {
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(Object.keys(pre).length ? { pre } : {}),
      effect,
    },
  };
}
