// LLM 槽位 —— 「模型在哪几个槽位出现、没 key 怎么办」（《ontos-article.md》§4、§5.3）。
// 接口 + 组合原语；槽位选择（有 OPENAI_API_KEY 走真模型，否则罐头离线回退）收在组合根 runtime.ts，
// 边界经 EngineEnv.llm 下传——本文件不摸进程级单例。
// 实现在同目录：罐头 canned.ts（离线确定性 + 演示剧本），真模型 aiSdk.ts（提示词工程）。

import type { QueryRequest } from "../../schema/request";
import type { ObjectType, OntologyConfig } from "../../schema/config";
import type { TableInfo } from "../../infra/driver";
import type { PairAdvice } from "../../schema/verdict";
import type { DriverRegistry } from "../../infra/registry";
import { resolveTableInfos } from "../../infra/tables";
import { MSG, toResult, type Result } from "../../errors";

export interface LlmSlot {
  /** 实现名，留痕用（离线回退 / 真模型名） */
  readonly name: string;
  /** NL → 查询 JSON（问数槽位）。workspace 说出「哪个空间在问」：罐头剧本只服务 test 空间（演示数据），
   *  没有这条论元守卫只能借 config 拐弯——任何空间恰好有同名类就会被静默编成演示查询。 */
  nlToQuery(question: string, config: OntologyConfig, workspace: string): Promise<QueryRequest>;
  /** 表结构 → 本体草稿（逆向建模槽位）。occupied = 草稿里已有的类名：撞名时实现按 {connection}_{table} 起名，不静默覆盖。 */
  proposeObjects(tables: { connection: string; table: TableInfo }[], occupied?: string[]): Promise<Record<string, ObjectType>>;
  /** 跨源类两两比对 → 候选对与倾向（整合槽位）。sources 是该类的连接集合（跨源判定在实现里做）。 */
  proposePairs(classes: { name: string; sources: string[]; fields: string[] }[]): Promise<PairAdvice[]>;
}

/** 「表结构 → 对象建议」的组合原语：按连接内省定位 + 槽位产草稿。REST 与 MCP 的 propose_objects 共用；
 *  notFound 产出的错误类型由调用方定（REST 与 MCP 都传 EngineReject——路由按 422、MCP 按 -32000 映射）。 */
export async function proposeObjectsFor(
  slot: LlmSlot,
  registry: DriverRegistry,
  tables: { connection: string; table: string }[],
  notFound: (msg: string) => Error,
  occupied?: string[]
): Promise<Result<Record<string, ObjectType>>> {
  return toResult(async () => {
    const infos = await resolveTableInfos(registry, tables, notFound);
    return slot.proposeObjects(infos, occupied);
  }, (v) => MSG.resultProposed(Object.keys(v).length));
}

/** 撞名时的改名规则（唯一出处）：{connection}_{table}。罐头槽位（本次/草稿已占）与落地前硬闸同用这一条。 */
export function prefixedTableName(connection: string, table: string): string {
  return `${connection}_${table}`;
}

/** 落地前的撞名消解硬闸（propose_objects 路由交还结果前）：键已占用（草稿已有或本次已收下）时，
 *  按 prefixedTableName 改成该类第一条源的名字；仍撞再补 _2。只改记录的键，不改编类体。
 *  import_objects 本身不静默改名（MCP 直接 apply 仍整批 422——外部 Agent 不该以为类名还是旧名）。 */
export function disambiguateClassNames(objects: Record<string, ObjectType>, occupied: string[]): Record<string, ObjectType> {
  const taken = new Set(occupied);
  const out: Record<string, ObjectType> = {};
  for (const [name, obj] of Object.entries(objects)) {
    let key = name;
    if (taken.has(key)) {
      const src = Object.values(obj.sources ?? {})[0];
      key = src ? prefixedTableName(src.connection, src.table) : `${name}_2`;
      while (taken.has(key)) key = `${key}_2`;
    }
    taken.add(key);
    out[key] = obj;
  }
  return out;
}
