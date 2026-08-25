// 引用扫描 —— 「这个名字还被谁引用」的唯一出处：删除属性/关系前的拦截面。
// 纯函数（config in → 引用清单 out），filterSpec 的最大消费方；ops/ 各编辑文件只调两个入口。
// 扫面：源映射、公理、关系配对与转化、同类与他类派生规则、动作（pre/effect/inform，含 $link 跨类落点、值侧 { property }）。

import type { OntologyConfig } from "../../schema/config";
import { walkFilter } from "../../schema/spec/filterSpec";
import { walkEffectItems, type CreateItem, type DeleteItem, type UpdateItem } from "../../schema/spec/actionSpec";
import { MSG } from "../../errors";

/** 连接是否被已发布本体引用（删连接前的拦截面）：任一类的任一源条目挂着它即算。 */
export function connectionInUse(config: OntologyConfig, name: string): boolean {
  return Object.values(config.object_types).some((t) => Object.values(t.sources ?? {}).some((s) => s.connection === name));
}

/** 删除属性前的引用扫描：源映射、关系配对、转化、公理、同类派生规则、动作（含跨类）。
 *  返回的是给人看的 trail 文案（报错消息用）；判定例外走结构参数 exceptAction——
 *  「set_fields 的键跟随不算断链」这类例外在扫描层就是结构排除，谁也不许拿文案字串当判据。 */
export function referencesOf(d: OntologyConfig, clsName: string, prop: string, opts?: { exceptAction?: string }): string[] {
  const refs: string[] = [];
  const cls = d.object_types[clsName];
  for (const [src, e] of Object.entries(cls.sources ?? {})) if (e.fields[prop]) refs.push(MSG.trailSource(src));
  for (const [name, ax] of Object.entries(cls.axioms ?? {})) if (ax.property === prop) refs.push(MSG.trailAxiom(name));
  for (const [name, link] of Object.entries(d.link_types)) {
    if (link.from === clsName && link.match?.some((p) => p.from === prop)) refs.push(MSG.trailLink(name));
    if (link.to === clsName && link.match?.some((p) => p.to === prop)) refs.push(MSG.trailLink(name));
    if (link.from === clsName && link.transition?.property === prop) refs.push(MSG.trailLink(name));
  }
  // 同类派生规则的过滤键
  for (const [p, def] of Object.entries(cls.properties)) {
    if (p !== prop && def.derived && derivedFilterKeys(def.derived).includes(prop)) refs.push(MSG.trailDerivedProp(p));
  }
  refs.push(...actionRefs(d, clsName, prop, opts?.exceptAction));
  // 他类派生经 $link 落到本类的过滤键（键侧，跨类）
  for (const [hostName, hostCls] of Object.entries(d.object_types)) {
    if (hostName === clsName) continue;
    for (const [p, def] of Object.entries(hostCls.properties)) {
      if (!def.derived) continue;
      for (const cond of derivedConds(def.derived)) collectNestedLinkRefs(d, cond, hostName, clsName, prop, MSG.trailDerived(hostName, p), (t) => refs.push(t));
    }
  }
  // 值侧引用：过滤/赋值里的 { property: prop }（被比较、被读取的属性也是引用）。
  // 派生侧与动作侧同口径（全 host 扫描）：他类派生的 $link 子过滤值侧也可能引用本类属性——
  // valuePropRefs 递归 $link 时会换宿主类，同类限制会把这一种形状漏掉
  const valueRefs = new Set<string>();
  for (const [hostName, hostCls] of Object.entries(d.object_types)) {
    for (const [p, def] of Object.entries(hostCls.properties)) {
      if (!def.derived) continue;
      for (const cond of derivedConds(def.derived)) valuePropRefs(cond, hostName, MSG.trailDerived(hostName, p), d, clsName, prop, valueRefs);
    }
    for (const [actName, act] of Object.entries(hostCls.actions ?? {})) {
      const trail = MSG.trailAction(hostName, actName);
      valuePropRefs(act.pre, hostName, trail, d, clsName, prop, valueRefs);
      walkEffectItems(act, {
        update: (item) => {
          if (item.filter) valuePropRefs(item.filter, item.object, trail, d, clsName, prop, valueRefs);
          // update 的 current 是目标类视图
          for (const v of Object.values(item.properties)) valuePropRefs(v, item.object, trail, d, clsName, prop, valueRefs);
        },
        create: (item) => {
          // create 的 current 是动作宿主（主体）视图
          for (const v of Object.values(item.properties)) valuePropRefs(v, hostName, trail, d, clsName, prop, valueRefs);
        },
        delete: (item) => {
          if (item.filter) valuePropRefs(item.filter, item.object, trail, d, clsName, prop, valueRefs);
        },
      });
      // inform 的属性表在动作宿主（主体）上取值
      for (const inf of act.inform ?? []) {
        for (const v of Object.values(inf.properties)) valuePropRefs(v, hostName, trail, d, clsName, prop, valueRefs);
      }
    }
  }
  refs.push(...valueRefs);
  return refs;
}

/** 关系的引用扫描：动作 pre 的 $link、effect 的 link 项、effect update/delete 的 filter.$link、派生规则里的 $link。删关系前挡一道。 */
export function linkRefs(d: OntologyConfig, linkName: string): string[] {
  const refs = new Set<string>();
  const walk = (f: unknown, trail: string) => {
    if (!f || typeof f !== "object") return;
    // 结构遍历（不解析目标类）：每个 $link 条目都发事件，命中关系名即记账
    walkFilter(null, "", f as Record<string, unknown>, {
      link: (_c, ln) => {
        if (ln === linkName) refs.add(trail);
      },
    });
  };
  for (const [clsName, cls] of Object.entries(d.object_types)) {
    for (const [actName, act] of Object.entries(cls.actions ?? {})) {
      const trail = MSG.trailAction(clsName, actName);
      walk(act.pre, trail);
      walkEffectItems(act, {
        link: (name) => { if (name === linkName) refs.add(trail); },
        update: (item) => walk(item.filter, trail),
        delete: (item) => walk(item.filter, trail),
      });
    }
    for (const [p, def] of Object.entries(cls.properties)) {
      if (!def.derived) continue;
      for (const cond of derivedConds(def.derived)) walk(cond, MSG.trailDerived(clsName, p));
    }
  }
  return [...refs];
}

/** $link 嵌套走查（键侧跨类引用）：子过滤落在 clsName 且顶层键点名 prop 时把 trail 记账。派生规则与动作 pre/effect 共用。 */
function collectNestedLinkRefs(d: OntologyConfig, f: unknown, hostCls: string, clsName: string, prop: string, trail: string, add: (t: string) => void): void {
  if (!f || typeof f !== "object") return;
  walkFilter(d, hostCls, f as Record<string, unknown>, {
    link: (_c, _ln, target, sub) => {
      if (!target) return false; // 未解析的关系不再深入（校验另行拦）
      if (target === clsName && sub && typeof sub === "object" && !Array.isArray(sub) && filterTopKeys(sub as Record<string, unknown>).includes(prop)) add(trail);
    },
  });
}

/** 值侧的 { property: x } 引用（from: request 指的是请求参数，不算）：递归过滤树/赋值表，命中即记账。
 *  带 $link 的节点是过滤：子过滤按目标类换宿主（走 schema 层 walkFilter）；其余节点通用深挖。 */
function valuePropRefs(
  node: unknown,
  hostCls: string,
  trail: string,
  d: OntologyConfig,
  clsName: string,
  prop: string,
  refs: Set<string>
): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const rec = node as Record<string, unknown>;
  if (typeof rec.property === "string" && rec.from !== "request" && hostCls === clsName && rec.property === prop) refs.add(trail);
  if ("$link" in rec) {
    walkFilter(d, hostCls, rec, {
      link: () => {},
      prop: (cls, _k, v) => valuePropRefs(v, cls, trail, d, clsName, prop, refs),
      // special（$request 等）块里的 { property } 指请求参数袋，不算
    });
    return;
  }
  for (const [k, v] of Object.entries(rec)) {
    if (k === "$request") continue;
    if (v && typeof v === "object") valuePropRefs(v, hostCls, trail, d, clsName, prop, refs);
  }
}

/** 派生定义里的条件过滤序列：列表派生展开每条 rule.when 的各源条件（src→cond 映射拆到 cond 层）；布尔派生就是过滤本体。
 *  $link 可能藏在 cond 里——不拆到这层，跨类引用与关系引用都会漏（老实现的盲区）。 */
function derivedConds(derived: unknown): Record<string, unknown>[] {
  if (Array.isArray(derived)) {
    return derived.flatMap((r) => Object.values((r as { when: Record<string, unknown> }).when).filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object"));
  }
  return derived && typeof derived === "object" ? [derived as Record<string, unknown>] : [];
}

/** 过滤的顶层属性键（$ 键不进）。 */
function filterTopKeys(f: Record<string, unknown>): string[] {
  return Object.keys(f).filter((k) => !k.startsWith("$"));
}

/** 派生定义里出现的本类属性键（when 过滤 + 布尔过滤）。$link 嵌套里的键是目标类的，不收——跨类引用由 collectNestedLinkRefs 负责。 */
function derivedFilterKeys(derived: unknown): string[] {
  return derivedConds(derived).flatMap((cond) => filterTopKeys(cond));
}

/** 动作里的引用：本类 pre 的键；任意效应指向本类时的属性键；$link 目标过滤落回本类的键。
 *  exceptAction：本类上这个名字的动作整跳过（结构例外——set_fields 的键跟随、不算断链）。 */
function actionRefs(d: OntologyConfig, clsName: string, prop: string, exceptAction?: string): string[] {
  const refs = new Set<string>();
  for (const [hostName, hostCls] of Object.entries(d.object_types)) {
    for (const [actName, act] of Object.entries(hostCls.actions ?? {})) {
      if (hostName === clsName && actName === exceptAction) continue; // 结构例外，不靠文案识别
      const trail = MSG.trailAction(hostName, actName);
      if (hostName === clsName && act.pre && filterTopKeys(act.pre).includes(prop)) refs.add(trail);
      collectNestedLinkRefs(d, act.pre, hostName, clsName, prop, trail, (t) => refs.add(t));
      const effRef = (item: UpdateItem | CreateItem | DeleteItem) => {
        if (item.object !== clsName) return; // 他类效应不归这里管（link 没有属性键，不挂回调）
        const keys = [
          ...("properties" in item && item.properties ? Object.keys(item.properties) : []),
          ...("filter" in item && item.filter ? filterTopKeys(item.filter) : []),
        ];
        if (keys.includes(prop)) refs.add(trail);
        if ("filter" in item) collectNestedLinkRefs(d, item.filter, clsName, clsName, prop, trail, (t) => refs.add(t));
      };
      walkEffectItems(act, { update: effRef, create: effRef, delete: effRef });
    }
  }
  return [...refs];
}
