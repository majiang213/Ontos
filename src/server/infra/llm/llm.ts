// LLM 接口 —— 「模型在哪几个出口出现、没 Key 怎么办」（《ontos-article.md》§4、§5.3）。
// 整合出口两次出场：proposePairs 看名字、连接集合和字段名；proposePair 看过交集率再给倾向。
// 接口 + 组合原语；实现选择（有 OPENAI_API_KEY 走真模型 AiSdkLlm；没 Key 时 test 空间走演示实现
// DemoLlm，其他空间直接报错——演示剧本只属于 test）收在组合根 runtime.ts，边界经 EngineEnv.llm(workspace) 下传。
// 实现在同目录：演示实现 demo.ts（离线确定性 + 演示剧本），真模型 aiSdk.ts（提示词工程）。

import type { QueryRequest } from "../../schema/request";
import type { Literal, ObjectType, OntologyConfig } from "../../schema/config";
import type { TableInfo } from "../../infra/driver";
import type { PairAdvice, Tendency } from "../../schema/verdict";
import type { DriverRegistry } from "../../infra/registry";
import { resolveTableInfos } from "../../infra/tables";
import { MSG, toResult, type Result } from "../../errors";

/** 建议输入里的一个类的快照：名字、连接集、字段名，外加枚举属性的取值（时期名判据的证据——建议词必须从这里面原样取）。 */
export interface ClassShot {
  name: string;
  sources: string[];
  fields: string[];
  enums: { name: string; values: Literal[] }[];
}

/** 唯一键识别的候选列快照（proposeKey 的输入）：候选列名 + 硬信号 + 试算证据（扫描行数/去重数/各候选对命中）。
 *  intraUnique = 每个源表内都无重复（逐源判定，跨源重合不算重复）；false = 表内已有重复，不能当唯一键。 */
export interface KeyCandidateShot {
  name: string;
  description?: string;
  unique?: boolean; // 单列唯一约束（硬信号）
  pk?: boolean; // 非整数主键（硬信号）
  rows: number; // 试算扫描总行数（每源 ≤ KEY_TRIAL_SCAN）
  distinct: number; // 归一化并集去重数
  intraUnique: boolean;
  hits: { class_b: string; column: string; hit: number; total_a: number; total_b: number }[];
}

/** 唯一键建议（proposeKey 的输出）：key 为 null = 选不出，留给人定。 */
export type KeySuggestion = { key: string; reason: string } | { key: null; reason: string };

export interface Llm {
  /** 实现名，留痕用（演示实现 / 真模型名） */
  readonly name: string;
  /** NL → 查询 JSON（问数调用口）。workspace 说出「哪个空间在问」：演示剧本只服务 test 空间（演示数据），
   *  没有这条论元守卫只能借 config 拐弯——任何空间恰好有同名类就会被静默编成演示查询。 */
  nlToQuery(question: string, config: OntologyConfig, workspace: string): Promise<QueryRequest>;
  /** 表结构 → 本体草稿（逆向建模调用口）。occupied = 草稿里已有的类名：撞名时实现按 {connection}_{table} 起名，不静默覆盖。 */
  proposeObjects(tables: { connection: string; table: TableInfo }[], occupied?: string[]): Promise<Record<string, ObjectType>>;
  /** 有源类两两比对 → 候选对、倾向与可执行方案（整合调用口）。sources 是该类的连接集合；同一连接的两张表也可以成对。资格闸在 eligibility，实现里不做跨源判定。 */
  proposePairs(classes: ClassShot[]): Promise<PairAdvice[]>;
  /** 看过交集率之后，对这一对再给倾向与可执行方案（仍是整合调用口）。比率由调用方算好传入，实现不当计算器。
   *  base 是清单里的第一版建议（候选快照钉住的同一裁判）：第二版以它为锚——维持，或由证据驱动改口，不另起炉灶。 */
  proposePair(input: {
    class_a: ClassShot;
    class_b: ClassShot;
    overlap: { rate: number; count_a: number; count_b: number; count_hit: number };
    base?: { tendency: Tendency; reason: string };
  }): Promise<PairAdvice>;
  /** 看过数据试算之后，从候选列里选唯一键（整合调用口）。试算由调用方算好传入，实现不当计算器。 */
  proposeKey(input: { name: string; current?: string; candidates: KeyCandidateShot[] }): Promise<KeySuggestion>;
}

/** 「表结构 → 对象建议」的组合原语：按连接内省定位 + 实现产草稿。REST 与 MCP 的 propose_objects 共用；
 *  notFound 产出的错误类型由调用方定（REST 与 MCP 都传 EngineReject——路由按 422、MCP 按 -32000 映射）。 */
export async function proposeObjectsFor(
  llm: Llm,
  registry: DriverRegistry,
  tables: { connection: string; table: string }[],
  notFound: (msg: string) => Error,
  occupied?: string[]
): Promise<Result<Record<string, ObjectType>>> {
  return toResult(async () => {
    const infos = await resolveTableInfos(registry, tables, notFound);
    return llm.proposeObjects(infos, occupied);
  }, (v) => MSG.resultProposed(Object.keys(v).length));
}

/** 撞名时的改名规则（唯一出处）：{connection}_{table}。演示实现（本次/草稿已占）与落地前硬闸同用这一条。 */
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
