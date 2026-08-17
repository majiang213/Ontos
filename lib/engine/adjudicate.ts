// 裁决应用 —— 把定案写进工作副本（《ontos-article.md》§3.2 五种结论的处理）。
// 同一：合并为一个对象、挂多源。阶段：收成一类 + 派生阶段 + 转化关系 + 转化动作。
// 部分重叠：公共属性立上位对象（属性移上去，不带继承）。仅名称相似/跳过：不动配置。

import type { OntologyConfig } from "../schema/config";
import { mutateDraft } from "./configStore";

export type Verdict = "同一" | "部分重叠" | "阶段" | "仅名称相似" | "跳过";

/** 把 B 的源并进 A：B 的属性先随类带过来（同名跳过），源映射的列再按同名属性对上；B 类撤掉。 */
function mergeInto(d: OntologyConfig, a: string, b: string): void {
  const A = d.object_types[a];
  const B = d.object_types[b];
  if (!A || !B) throw new Error(`类不存在：${a} 或 ${b}`);
  // B 的属性并入 A：同名已有不动，特有（含未映射的 manual 属性）带过来
  for (const [prop, def] of Object.entries(B.properties)) {
    if (!A.properties[prop]) A.properties[prop] = def;
  }
  A.sources = A.sources ?? {};
  for (const [srcName, entry] of Object.entries(B.sources ?? {})) {
    const newName = A.sources[srcName] ? `${srcName}_${b}` : srcName;
    A.sources[newName] = { ...entry, fields: { ...entry.fields } }; // 属性名已对齐，列名映射照搬
  }
  delete d.object_types[b];
  for (const [linkName, link] of Object.entries(d.link_types)) {
    if (link.from === b || link.to === b) delete d.link_types[linkName]; // B 挂着的关系一并撤
  }
}

export function applyVerdict(d: OntologyConfig, pair: { class_a: string; class_b: string }, verdict: Verdict, stageNames?: { from: string; to: string }): void {
  const { class_a: a, class_b: b } = pair;
  switch (verdict) {
    case "同一":
      mergeInto(d, a, b);
      break;
    case "仅名称相似":
    case "跳过":
      break; // 各自独立，互不映射——配置不动
    case "阶段": {
      const from = stageNames?.from ?? `${a}_前`;
      const to = stageNames?.to ?? `${b}_后`;
      const A = d.object_types[a];
      const B = d.object_types[b];
      if (!A || !B) throw new Error(`类不存在：${a} 或 ${b}`);
      // 两个源都挂到 A 上（B 的源条目改名带 b 后缀防撞）
      A.sources = A.sources ?? {};
      for (const [srcName, entry] of Object.entries(B.sources ?? {})) {
        A.sources[A.sources[srcName] ? `${srcName}_${b}` : srcName] = entry;
      }
      const srcA = Object.keys(A.sources ?? {})[0];
      const srcB = Object.keys(B.sources ?? {})[0] ?? Object.keys(A.sources!)[1];
      // 阶段是派生属性：按个体出现在哪些源现算
      A.properties.status = {
        type: "enum",
        values: [from, to],
        description: "阶段",
        derived: [
          { when: { [srcA]: true, [srcB]: false }, value: from },
          { when: { [srcB]: true }, value: to },
        ],
      };
      // 转化写成关系，由动作写入
      d.link_types[`${a}_to_${to}`] = {
        from: a,
        to: a,
        inverse: `${a}_from_${from}`,
        card: "1:1",
        transition: { property: "status", from, to },
      };
      A.actions = A.actions ?? {};
      A.actions[`convert_to_${to}`] = {
        description: `转化为${to}`,
        pre: { status: from, $link: { [`${a}_to_${to}`]: false } },
        effect: [{ link: `${a}_to_${to}` }],
      };
      delete d.object_types[b];
      break;
    }
    case "部分重叠": {
      // 公共属性立上位对象：属性是移上去的，不带继承语义
      const A = d.object_types[a];
      const B = d.object_types[b];
      if (!A || !B) throw new Error(`类不存在：${a} 或 ${b}`);
      const common = Object.keys(A.properties).filter((p) => p in B.properties && !A.properties[p].derived && !B.properties[p].derived);
      if (common.length === 0) throw new Error("两类没有公共属性，立不了上位对象");
      // 先按公共属性给上位对象搭好源映射（只带公共列），再从两类身上移走
      const parentSources: NonNullable<OntologyConfig["object_types"][string]["sources"]> = {};
      for (const [srcName, entry] of [...Object.entries(A.sources ?? {}), ...Object.entries(B.sources ?? {})]) {
        const fields = Object.fromEntries(common.filter((p) => entry.fields[p]).map((p) => [p, entry.fields[p]]));
        if (Object.keys(fields).length === 0) continue; // 一条公共列都不带的源不挂
        parentSources[parentSources[srcName] ? `${srcName}_${a}` : srcName] = { ...entry, fields };
      }
      const parent = `shared_${a}_${b}`;
      const parentProps: OntologyConfig["object_types"][string]["properties"] = {};
      for (const p of common) {
        parentProps[p] = A.properties[p];
        delete A.properties[p];
        delete B.properties[p];
        for (const entry of Object.values(A.sources ?? {})) delete entry.fields[p];
        for (const entry of Object.values(B.sources ?? {})) delete entry.fields[p];
      }
      d.object_types[parent] = {
        kind: "thing",
        description: `${a} 与 ${b} 的公共部分`,
        identity: A.identity ?? B.identity,
        properties: parentProps,
        sources: parentSources,
      };
      break;
    }
  }
}

/** 事务入口：走 configStore 的草稿变更通道（dirty 重算）。 */
export function adjudicate(pair: { class_a: string; class_b: string }, verdict: Verdict, stageNames?: { from: string; to: string }): void {
  mutateDraft((d) => applyVerdict(d, pair, verdict, stageNames));
}
