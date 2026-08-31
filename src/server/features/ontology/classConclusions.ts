// 还活着的类与类结论：部分重叠的由来、同形异义。配置里一份，画布和 read_class 只投影这里。

import type { ClassConclusion, OntologyConfig } from "../../schema/config";

/** 还活着的类都在 object_types 里的那些行。 */
export function liveConclusions(config: Pick<OntologyConfig, "object_types" | "class_conclusions">): ClassConclusion[] {
  const live = new Set(Object.keys(config.object_types));
  return (config.class_conclusions ?? []).filter((row) => {
    if (!row.classes.every((c) => live.has(c))) return false;
    // 历史草稿的 overlap 带 shared：上位对象还活着结论才活着；新裁决（ADR 0013）不写 shared，只看两类
    if (row.kind === "overlap" && row.shared && !live.has(row.shared)) return false;
    return true;
  });
}

/** 某个类参与的结论（原类或上位对象）。 */
export function conclusionsAbout(config: Pick<OntologyConfig, "object_types" | "class_conclusions">, name: string): ClassConclusion[] {
  return liveConclusions(config).filter((row) => row.classes.includes(name) || row.shared === name);
}
