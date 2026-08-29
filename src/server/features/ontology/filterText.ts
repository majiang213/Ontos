// 过滤树/属性条件的白话渲染 —— 一份实现两处消费:阶段条件全文(explainWhen)与动作前置摘要(preSummary)。
// 一条属性条件 = 「键 运算词 取值」;取值只说来源(请求里的 X/这条记录的 X/请求点名的对象),不落 JSON。
// 类名/属性名/关系名照配置原样(机器名),不翻中文。

import { isOpObject } from "../../schema/spec/filterSpec";

const OP_WORDS: Record<string, string> = { eq: "是", ne: "不是", lt: "早于", lte: "不晚于", gt: "晚于", gte: "不早于", contains: "包含" };

/** 过滤取值的白话:字面量原样;复合取值说来源;数组顿号连。 */
export function operandText(v: unknown): string {
  if (v === null || v === undefined) return "空";
  if (Array.isArray(v)) return v.map((x) => String(x)).join("、");
  if (typeof v !== "object") return String(v);
  const o = v as Record<string, unknown>;
  if ("property" in o) {
    const p = String(o.property);
    if (o.from === "request") return `请求里的 ${p}`;
    if (o.from === "current") return `这条记录的 ${p}`;
    return p;
  }
  if (o.from === "request") return "请求里的值";
  if (o.from === "identity") return "请求点名的对象";
  return JSON.stringify(v); // 兜底:合法配置走不到(取值只有上面几种形状)
}

/** 一条属性条件:「key 是 X」;运算符块逐运算符展开(「key 不晚于 X」「key 是 A、B 之一」)。 */
export function conditionText(key: string, v: unknown): string {
  if (v !== null && typeof v === "object" && !Array.isArray(v) && isOpObject(v)) {
    return Object.entries(v)
      .map(([op, x]) => (op === "in" ? `${key} 是 ${operandText(x)} 之一` : `${key} ${OP_WORDS[op] ?? op} ${operandText(x)}`))
      .join("、");
  }
  return `${key} 是 ${operandText(v)}`;
}

/** 一棵过滤树逐条白话，顿号连。$link 按存在性说（有关系/没有关系），带子条件就地展开。 */
export function filterText(filter: Record<string, unknown>): string {
  return Object.entries(filter)
    .map(([k, v]) => {
      if (k === "$link") {
        return Object.entries(v as Record<string, unknown>)
          .map(([ln, sub]) =>
            sub === true ? `有关系 ${ln}` : sub === false ? `没有关系 ${ln}` : `关系 ${ln}：${filterText(sub as Record<string, unknown>)}`
          )
          .join("、");
      }
      if (k.startsWith("$")) return `${k} 条件`; // when/pre 里不该出现的 $ 键；不美化，照名字说
      return conditionText(k, v);
    })
    .join("、");
}
