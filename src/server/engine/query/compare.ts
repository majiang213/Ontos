// 行级比较 —— 操作数求值与条件核对，纯叶子（不依赖 individual：不碰个体、不查配置）。
// 过滤形状校验（assertFilterShapes）也在这：查询与动作入口各跑一次，下推与内存共用同一把尺。
// 「一条过滤成不成立」的地图（四层各一段，读哪层开哪个）：形状校验在本文件；个体/派生核对在 evaluate.ts；
// 运算符语义（含「空=至今」）在 filterOp.ts；字面量与日期/数字表达式在 expr.ts。下推编成另有一条链（assemble → filterOp.pushCondition）。

import type { Filter } from "../../schema/config";
import { walkFilter } from "../../schema/spec/filterSpec";
import { EngineReject, MSG } from "../../errors";
import { resolveLiteral, type EvalContext } from "./expr";
import { compare } from "./filterOp";
import { isOpObject } from "../../schema/spec/filterSpec";

/** 操作数求值（异步：派生属性可能要查源）：字面量、ISO 日期串、日期表达式、{ property, from }、{ from: identity }。 */
export async function resolveOperand(v: unknown, ctx: EvalContext): Promise<unknown> {
  if (Array.isArray(v)) {
    try {
      return v.map((x) => resolveLiteral(x)); // in 的值是数组，元素级解析（ISO 串落成秒）
    } catch (e) {
      throw new EngineReject(e instanceof Error ? e.message : String(e)); // 与标量分支同口径：非法表达式 422 不是 500
    }
  }
  if (v !== null && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    if (typeof rec.property === "string") {
      if (rec.from === "request") {
        try {
          return resolveLiteral(ctx.request?.[rec.property]); // 请求参数：严格，非法拒绝
        } catch (e) {
          throw new EngineReject(e instanceof Error ? e.message : String(e));
        }
      }
      const hit = ctx.current?.[rec.property];
      if (hit === undefined) {
        // 派生按需现算。错误分类在源头就是对的：点错名（evalDerived/propValue）抛 EngineReject，
        // 源库故障（$link 派生真查库）是原生异常——都不需要在这里归一，原样透传即可
        if (ctx.currentDerived) return await ctx.currentDerived(rec.property);
        throw new EngineReject(MSG.operandMissing(String(rec.property))); // 下推层接到这个错就退回内存核对
      }
      return dataLiteral(hit); // 源库数据：只转换，不抛错
    }
    if (rec.from === "identity") return ctx.identity;
    throw new EngineReject(MSG.operandUnknown(JSON.stringify(v)));
  }
  try {
    return resolveLiteral(v); // 请求侧表达式非法 → 422
  } catch (e) {
    throw new EngineReject(e instanceof Error ? e.message : String(e));
  }
}

/** 数据侧的值只做转换、不抛错：源列里写什么不归引擎管，形似而非法就按原字符串比。 */
function dataLiteral(v: unknown): unknown {
  try {
    return resolveLiteral(v);
  } catch {
    return v;
  }
}

/** 单个条件是否成立。actual 为 undefined（个体或该值不存在）时一律不成立。
 *  dateLike=true（仅 date 类型属性）时 null 按「空=至今」处理：actual 为空时 gt/gte 成立；expected 为空时 lt/lte 成立。 */
export async function conditionHolds(actual: unknown, condVal: unknown, ctx: EvalContext, dateLike = false): Promise<boolean> {
  const a = dataLiteral(actual); // ISO 日期串落成秒；脏数据不抛错
  if (isOpObject(condVal)) {
    for (const op of Object.keys(condVal)) {
      if (!compare(a, op, await resolveOperand(condVal[op], ctx), dateLike)) return false;
    }
    return true;
  }
  // 裸的 { property, from } 或等值位字面量：日期表达式、ISO 串落成秒，非法表达式拒绝
  return compare(a, "eq", await resolveOperand(condVal, ctx), dateLike);
}

/** 过滤值形状校验：in 的值必须数组；其余运算符与等值位不许数组；$link 嵌套限三层（防深层扇出）。
 *  查询与动作入口各跑一次，下推与内存共用同一把尺。遍历走 schema 层 walkFilter（结构遍历，不解析关系）。 */
export function assertFilterShapes(filter: Filter, trail = "过滤"): void {
  walkFilter(null, "", filter, {
    link: (_cls, _ln, _target, _sub, depth) => {
      if (depth + 1 > 3) throw new EngineReject(MSG.linkNestTooDeep(trail));
      // 存在性写法（true/false）没有子过滤：walker 对非对象本就不递归
    },
    prop: (_cls, key, v) => {
      if (Array.isArray(v)) throw new EngineReject(MSG.eqNoArray(trail, key));
      if (isOpObject(v)) {
        for (const [op, operand] of Object.entries(v)) {
          if (op === "in") {
            if (!Array.isArray(operand)) throw new EngineReject(MSG.inNeedsArray(trail, key));
          } else if (Array.isArray(operand)) {
            throw new EngineReject(MSG.opNoArray(trail, key, op));
          }
        }
      }
      // 裸的 { property, from } 是操作数不是运算符块，跳过
    },
  });
}
