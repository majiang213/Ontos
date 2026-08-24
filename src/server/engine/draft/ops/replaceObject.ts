// 整份替换 —— 不变量：只在未锁定时允许。锁定判定（replaceBlockers，纯函数）与执行（replace_object op）同文件：
// 读路径（views 的 replaceable/replace_blockers）只 import 判定，与写路径共用同一份规则、同一份文案。

import type { ObjectType, OntologyConfig } from "../../../schema/config";
import type { DraftOpInput as DraftOp } from "../../../schema/ops";
import { DraftReject } from "../../../errors";

type ReplaceObjectOp = Extract<DraftOp, { op: "replace_object" }>;

/** 整份替换（replace_object）的锁定规则，与 read_class space=draft 的 replaceable/replace_blockers 共用——读路径和写路径不写两份文案。
 *  命中一条即锁定。集合非空一律用 Object.keys 计数：actions: {} / axioms: {} 在 JS 里为真，LLM 草稿常带空 map，不能当真值误锁。 */
export function replaceBlockers(existing: ObjectType, publishedHasClass: boolean): string[] {
  const reasons: string[] = [];
  if (publishedHasClass) reasons.push("已经发布过");
  if (Object.values(existing.properties).some((p) => p.derived)) reasons.push("含派生字段");
  if (Object.keys(existing.actions ?? {}).length > 0) reasons.push("含动作");
  if (Object.keys(existing.axioms ?? {}).length > 0) reasons.push("含公理");
  const sources = Object.values(existing.sources ?? {});
  if (sources.length > 1) reasons.push("挂了多个来源");
  if (sources.length >= 1) {
    // 「未对照到表列的字段」只锁挂了来源的类：没挂来源的残缺生成（猜不到识别字段时不写 sources）正是整份替换要救的
    const mapped = new Set(sources.flatMap((s) => Object.keys(s.fields)));
    if (Object.entries(existing.properties).some(([p, def]) => !def.derived && !mapped.has(p))) reasons.push("含有未对照到表列的字段");
  }
  return reasons;
}

/** replace_object：整份替换未锁定的类。关系留在 link_types（不走 dropClass），摆位不动；
 *  替换后 match 断了由 validateSemantics 整步回退。 */
export function replaceObject(d: OntologyConfig, input: ReplaceObjectOp, published: OntologyConfig): void {
  const cur = d.object_types[input.name];
  if (!cur) throw new DraftReject(`类不存在：${input.name}，新建请用 import_objects`);
  const blockers = replaceBlockers(cur, Boolean(published.object_types[input.name]));
  if (blockers.length) throw new DraftReject(`${input.name} 不能整对象替换：${blockers.join("；")}。请用增删字段等逐步操作`);
  d.object_types[input.name] = input.def; // Zod 已在 schema 层 parse（并剥掉 actions/axioms）
}
