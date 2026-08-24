// 对象卡动作区的纯函数：效应摘要（effectSummary）、表单兼容白名单（formCompatible）、
// 动作表单往返（prefillPre/prefillEff/buildActionDef，从 forms.tsx 抽出来单测）。
// 不依赖 React。规则见《外部Agent编辑画布.md》§6。轮询 toast 与帧类型在 ../ontFrame。

import type { ActionDef, OntologyConfig } from "../../server/schema/config";
import { isFromOnly } from "../../server/schema/spec/valueSpec";
import { formLinkOk, formPreOk, formValueKind, inFormSubset, walkEffectItems, walkEffectValues } from "../../server/schema/spec/actionSpec";
import { walkFilter } from "../../server/schema/spec/filterSpec";

/** 效应摘要：一条效应一行白话，inform 另列。类名/属性名/关系名用配置里的机器名。
 *  不展示 from / 字面量 / filter / identity——同一属性换取值来源或字面量，摘要一行不变（摘要是给人看的告警，不是审计）。 */
export function effectSummary(def: ActionDef): string[] {
  const lines: string[] = [];
  walkEffectItems(def, {
    update: (item) => lines.push(`把 ${item.object} 的 ${Object.keys(item.properties).join("、")} 写成新值`),
    delete: (item) => lines.push(`撤走 ${item.object}`), // 毒性关卡底线：「撤走」一行不能省
    create: (item) => lines.push(`新建 ${item.object}`),
    link: (name) => lines.push(`转化 ${name}`),
  });
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
  let ok = true;
  walkFilter(null, clsName, def.pre ?? {}, {
    prop: (_cls, key, v) => {
      const prop = cls.properties[key];
      if (!prop || prop.derived || !formPreOk(v)) ok = false; // 前置只能是本类非派生字段的等于/不等于字面量
    },
    link: (_cls, _name, _target, sub) => {
      if (!formLinkOk(sub)) ok = false; // 嵌套过滤表单不认
      return formLinkOk(sub) ? undefined : false; // 也不再往下走
    },
    special: () => {
      ok = false; // $request / $exists 表单不认
    },
  });
  walkEffectValues(def, {
    identity: (_op, item, v) => {
      if (item.object !== clsName || item.filter || formValueKind(v) !== "from:identity") ok = false; // 附录 B：请求点名的那个体必须这样认人
    },
    updateProp: (_item, p, v) => {
      const prop = cls.properties[p];
      if (!prop || prop.derived || !inFormSubset("effect.update.properties", v)) ok = false;
    },
    createProp: (item, p, v) => {
      const prop = config.object_types[item.object]?.properties[p];
      if (!prop || prop.derived || !inFormSubset("effect.create.properties", v)) ok = false; // 不要表达式、不要 from: generated
    },
    link: (name) => {
      const l = config.link_types[name];
      if (!l?.transition || l.from !== clsName || l.to !== clsName) ok = false;
    },
  });
  return ok;
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
  walkEffectItems(def, {
    update: (item) => rows.push({ kind: "update", rows: Object.entries(item.properties).map(([p, v]) => ({ prop: p, ...prefillVal(v) })) }),
    link: (name) => rows.push({ kind: "link", link: name }),
    create: (item) => rows.push({ kind: "create", object: item.object, rows: Object.entries(item.properties).map(([p, v]) => ({ prop: p, ...prefillVal(v) })) }),
    delete: () => rows.push({ kind: "delete" }),
  });
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
