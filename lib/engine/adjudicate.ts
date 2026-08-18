// 裁决应用 —— 把定案写进工作副本（《ontos-article.md》§3.2 五种结论的处理）。
// 同一：合并为一个对象、挂多源。阶段：收成一类 + 派生阶段 + 转化关系 + 转化动作。
// 部分重叠：公共属性立上位对象（属性移上去，识别字段复制不移动）。仅名称相似/跳过：不动配置。

import type { Filter, OntologyConfig } from "../schema/config";
import { mutateDraft } from "./configStore";

export type Verdict = "同一" | "部分重叠" | "阶段" | "仅名称相似" | "跳过";

/** B 的属性并入 A（同名跳过、特有带过来），B 的源映射照搬，B 挂着的关系撤掉。
 *  识别属性不同名时（A.sn × B.serial_no）：B 的识别属性不另立，B 源条目的 fields 键改写为 A 的识别属性——
 *  两识别字段同义正是「同一/阶段」的裁决前提，不改写则 fields 缺 A.identity 的映射，过不了发布校验。 */
function mergeInto(d: OntologyConfig, a: string, b: string): void {
  const A = d.object_types[a];
  const B = d.object_types[b];
  if (!A || !B) throw new Error(`类不存在：${a} 或 ${b}`);
  const remapId = A.identity && B.identity && A.identity !== B.identity ? B.identity : undefined;
  for (const [prop, def] of Object.entries(B.properties)) {
    if (prop === remapId) continue; // B 的识别属性并入 A 的识别属性，不另立
    if (!A.properties[prop]) A.properties[prop] = def;
  }
  A.sources = A.sources ?? {};
  for (const [srcName, entry] of Object.entries(B.sources ?? {})) {
    const newName = A.sources[srcName] ? `${srcName}_${b}` : srcName;
    const fields = { ...entry.fields };
    if (remapId && fields[remapId]) {
      fields[A.identity!] = fields[remapId];
      delete fields[remapId];
    }
    A.sources[newName] = { ...entry, fields };
  }
  // B 的动作与公理带过来（同名跳过）
  if (B.actions) {
    A.actions = A.actions ?? {};
    for (const [name, act] of Object.entries(B.actions)) if (!A.actions[name]) A.actions[name] = act;
  }
  if (B.axioms) {
    A.axioms = A.axioms ?? {};
    for (const [name, ax] of Object.entries(B.axioms)) if (!A.axioms[name]) A.axioms[name] = ax;
  }
  dropClass(d, b);
}

/** 撤一个类，连同挂着它的关系。 */
function dropClass(d: OntologyConfig, name: string): void {
  delete d.object_types[name];
  for (const [linkName, link] of Object.entries(d.link_types)) {
    if (link.from === name || link.to === name) delete d.link_types[linkName];
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
      if (!A || !d.object_types[b]) throw new Error(`类不存在：${a} 或 ${b}`);
      // 先并属性与源（与「同一」同款），再立阶段结构
      const srcKeysBefore = new Set(Object.keys(A.sources ?? {}));
      mergeInto(d, a, b);
      const newKeys = Object.keys(A.sources ?? {}).filter((k) => !srcKeysBefore.has(k));
      const srcA = Object.keys(A.sources ?? {})[0];
      const srcB = newKeys[0] ?? srcA; // B 并进来的第一个源条目
      if (!srcA || !srcB || srcA === srcB) throw new Error("阶段裁决需要两个不同的源条目");
      // 派生属性不进 fields：status 若是源列属性，先摘干净
      for (const entry of Object.values(A.sources ?? {})) delete entry.fields.status;
      A.properties.status = {
        type: "enum",
        values: [from, to],
        description: "阶段",
        derived: [
          { when: { [srcA]: true, [srcB]: false }, value: from },
          { when: { [srcB]: true }, value: to },
        ],
      };
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
        pre: { status: from, $link: { [`${a}_to_${to}`]: false } } as Filter,
        effect: [{ link: `${a}_to_${to}` }],
      };
      break;
    }
    case "部分重叠": {
      // 公共属性立上位对象：属性移上去，识别字段复制不移动（移了原类悬空）
      const A = d.object_types[a];
      const B = d.object_types[b];
      if (!A || !B) throw new Error(`类不存在：${a} 或 ${b}`);
      const idProps = new Set([A.identity, B.identity].filter(Boolean) as string[]);
      const common = Object.keys(A.properties).filter(
        (p) => p in B.properties && !A.properties[p].derived && !B.properties[p].derived && !idProps.has(p)
      );
      if (common.length === 0) throw new Error("两类没有公共属性（识别字段除外），立不了上位对象");
      const parent = `shared_${a}_${b}`;
      // 上位对象的源：公共列 + 识别列（识别列是读公共属性的对齐齐）
      const parentSources: NonNullable<OntologyConfig["object_types"][string]["sources"]> = {};
      for (const [side, cls] of [["a", A], ["b", B]] as const) {
        for (const [srcName, entry] of Object.entries(cls.sources ?? {})) {
          const keep = [...common, ...idProps].filter((p) => entry.fields[p]);
          if (keep.length === 0) continue;
          const fields = Object.fromEntries(keep.map((p) => [p, entry.fields[p]]));
          // 该侧源条目映射到的识别属性显式写进 key——上位对象的 identity 只取其一，另一侧靠 key 认行
          const sideId = [...idProps].find((p) => fields[p]);
          parentSources[parentSources[srcName] ? `${srcName}_${side}` : srcName] = { ...entry, fields, key: sideId };
        }
      }
      const parentProps: OntologyConfig["object_types"][string]["properties"] = {};
      for (const p of common) {
        parentProps[p] = A.properties[p];
        delete A.properties[p];
        delete B.properties[p];
        for (const entry of Object.values(A.sources ?? {})) delete entry.fields[p];
        for (const entry of Object.values(B.sources ?? {})) delete entry.fields[p];
      }
      // 识别属性复制给上位对象（不移动）
      for (const p of idProps) {
        const def = A.properties[p] ?? B.properties[p];
        if (def) parentProps[p] = def;
      }
      d.object_types[parent] = {
        kind: "thing",
        description: `${a} 与 ${b} 的公共部分`,
        identity: [...idProps][0],
        properties: parentProps,
        sources: parentSources,
      };
      break;
    }
  }
}

/** 事务入口：走 configStore 的草稿变更通道（dirty 重算 + 立即校验，不合法则回退）。 */
export function adjudicate(pair: { class_a: string; class_b: string }, verdict: Verdict, stageNames?: { from: string; to: string }): void {
  mutateDraft((d) => applyVerdict(d, pair, verdict, stageNames));
}
