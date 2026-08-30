// 唯一键识别 —— 「唯一键怎么识别」：候选列生成（当前建议 ∪ 单列唯一约束 ∪ 非整数主键 ∪ 名称/注释召回）→
// 数据试算（每列 ≤ KEY_TRIAL_SCAN 行：逐源表内唯一性 + 候选对命中）→ 实现综合判断（proposeKey）出建议。
// 只建议不落地（propose_ 前缀纪律）：建议预选进待确认面板①，人确认才 set_identity。
// 与交集率的边界：交集率在键定之后、按已定键算裁决证据（MAX_SCAN 5 万行）；识别在键定之前、按候选键试算
// （1 千行，识别是建议不是证据——千行采样只发现重复、不证明全局唯一，软保证语义与此一致）。
// 候选对取「建议原语」（pairProposals，键未定的类也算候选——识别正是为了定键）；疑似重复清单
// （listCandidates）是另一层读时过滤，键未定的类不进去（ADR 0010：不参与疑似重复）。

import type { EngineEnv } from "../env";
import type { DriverRegistry } from "../../infra/registry";
import type { TableInfo } from "../../infra/driver";
import type { ObjectType } from "../../schema/config";
import { getDraft } from "../ontology/current";
import { mustCls, sourcesOf, type Cls } from "../query/individual";
import { hasSources } from "./eligibility";
import { pairProposals } from "./candidates";
import { columnValues, normalizeWith, pickRule } from "./normalize";
import type { KeyCandidateShot, KeySuggestion } from "../../infra/llm/llm";
import { KEY_HINT_DESC_RE, KEY_HINT_NAME_RE } from "../../infra/llm/identityHint";
import { EngineReject, MSG, toResult, type Result } from "../../errors";
import { DEFAULT_WORKSPACE } from "../../infra/workspace";

/** 试算每列读取行数上限（每源）：识别是建议（人确认兜底），千行采样够发现重复、不追求全局唯一证明（软保证语义）。 */
const KEY_TRIAL_SCAN = 1000;

const isIntType = (t?: string) => !!t && t.toUpperCase().includes("INT");

interface CandidateCol {
  name: string;
  description?: string;
  unique?: boolean;
  pk?: boolean;
}

/** 候选列的进门凭据（四选一）：当前建议 / 单列唯一约束 / 非整数主键 / 名称或注释带业务编号特征（仅非整数列）。
 *  属性必须非派生、且映射进每一条源条目（唯一键要落到每个源，validate 的 cfgFieldsMissingKey 同口径）。
 *  硬信号（unique / pk）要每个源都成立才标：多源类任一源的映射列不唯一，整列的硬保证就不实。
 *  纯函数：tables 是「连接.表 → 表结构」的映射（内省失败降级为空表，此时只剩当前建议与名称/注释召回）。 */
export function candidateKeyColumns(cls: ObjectType, tables: Map<string, TableInfo>, current?: string): CandidateCol[] {
  const sources = Object.values(cls.sources ?? {});
  if (sources.length === 0) return [];
  const out: CandidateCol[] = [];
  for (const [prop, def] of Object.entries(cls.properties)) {
    if (def.derived) continue;
    if (!sources.every((e) => e.fields[prop])) continue;
    const tcs = sources.map((e) => tables.get(`${e.connection}.${e.table}`)?.columns.find((c) => c.name === e.fields[prop]));
    const uniqueAll = tcs.every((t) => t?.unique && !t.pk); // 单列唯一约束，且不是主键（主键走 pkHard 那条门）
    const pkAll = tcs.every((t) => t?.pk && !isIntType(t.type)); // 非整数主键：每个源都要是
    const recall =
      KEY_HINT_NAME_RE.test(prop) ||
      KEY_HINT_DESC_RE.test(def.description ?? "") ||
      tcs.some((t) => t?.comment && KEY_HINT_DESC_RE.test(t.comment));
    const recallOk = tcs.every((t) => !t || !isIntType(t.type)); // 任一源是整数列就不靠名字召回（自增代理键最常见的形态）
    if (prop === current || uniqueAll || pkAll || (recall && recallOk)) {
      out.push({
        name: prop,
        ...(def.description ? { description: def.description } : {}),
        ...(uniqueAll ? { unique: true } : {}),
        ...(pkAll ? { pk: true } : {}),
      });
    }
  }
  return out;
}

/** 类的候选列（带内省）：按连接去重后逐个内省。内省失败降级为空映射——试算拿不到硬信号，
 *  只剩当前建议与名称/注释召回，建议仍是建议（吞错安全：源故障由连接层另行报错，不挡识别）。 */
async function candidatesOf(registry: DriverRegistry, cls: Cls, current?: string): Promise<CandidateCol[]> {
  const tables = new Map<string, TableInfo>();
  const connections = [...new Set(sourcesOf(cls).map(([, entry]) => entry.connection))];
  for (const connection of connections) {
    try {
      for (const t of await registry.introspect(connection)) tables.set(`${connection}.${t.name}`, t);
    } catch {
      // 试算是建议不是证据：内省失败就不带该源的硬信号，不挡整个识别
    }
  }
  return candidateKeyColumns(cls.def, tables, current);
}

/** 数据试算：每源每列读 ≤ KEY_TRIAL_SCAN 行，归一化后求逐源唯一性与各候选对命中。
 *  表内唯一性与命中同口径：都按归一化后的值算——归一化碰撞（+86 前缀等）也是对齐撞车，同样算重复。 */
async function trial(
  registry: DriverRegistry,
  cls: Cls,
  candidates: CandidateCol[],
  mates: { name: string; cls: Cls; candidates: CandidateCol[] }[]
): Promise<KeyCandidateShot[]> {
  const readSets = async (
    c: Cls,
    cols: CandidateCol[]
  ): Promise<Map<string, { rows: number; distinct: number; intraUnique: boolean; set: Set<string> }>> => {
    const out = new Map<string, { rows: number; distinct: number; intraUnique: boolean; set: Set<string> }>();
    for (const col of cols) {
      let rows = 0;
      const perSource: string[][] = [];
      const raw: string[] = [];
      for (const [, entry] of sourcesOf(c)) {
        const sourceCol = entry.fields[col.name];
        if (!sourceCol) continue;
        let res: Record<string, unknown>[] = [];
        try {
          res = await registry.select(entry.connection, entry.table, [sourceCol], [], KEY_TRIAL_SCAN);
        } catch {
          // 试算是建议不是证据：单源读不出就跳过该源，不挡整个识别
        }
        const vals = columnValues(res, sourceCol);
        rows += vals.length;
        perSource.push(vals);
        raw.push(...vals);
      }
      let set = new Set<string>();
      let intraUnique = true;
      if (raw.length > 0) {
        const rule = pickRule(raw.slice(0, 20));
        set = new Set(raw.map((v) => normalizeWith(rule, v)));
        intraUnique = perSource.every((vals) => {
          const norm = vals.map((v) => normalizeWith(rule, v));
          return new Set(norm).size === norm.length; // 单源内归一化后出现重复 = 表内不唯一
        });
      }
      out.set(col.name, { rows, distinct: set.size, intraUnique, set });
    }
    return out;
  };
  const mine = await readSets(cls, candidates);
  const theirs = new Map<string, Map<string, { rows: number; distinct: number; intraUnique: boolean; set: Set<string> }>>();
  for (const m of mates) theirs.set(m.name, await readSets(m.cls, m.candidates));
  return candidates.map((col) => {
    const mineSet = mine.get(col.name)!;
    const hits = mates.flatMap((m) =>
      m.candidates.map((mc) => {
        const theirsSet = theirs.get(m.name)!.get(mc.name)!;
        let hit = 0;
        for (const v of mineSet.set) if (theirsSet.set.has(v)) hit++;
        return { class_b: m.name, column: mc.name, hit, total_a: mineSet.set.size, total_b: theirsSet.set.size };
      })
    );
    return {
      name: col.name,
      ...(col.description ? { description: col.description } : {}),
      ...(col.unique ? { unique: true } : {}),
      ...(col.pk ? { pk: true } : {}),
      rows: mineSet.rows,
      distinct: mineSet.distinct,
      intraUnique: mineSet.intraUnique,
      hits,
    };
  });
}

export interface KeyProposal {
  object: string;
  key: string | null;
  reason: string;
  hard: boolean; // 建议列带唯一约束或非整数主键（硬保证）；否则仅数据验证（软保证）
  evidence: KeyCandidateShot[];
}

/** 识别唯一键：候选列 + 数据试算 + 实现综合判断，只建议不落地。无源类拒绝；无候选对时试算为空（0 命中语义）。 */
export async function proposeKeyFor(env: EngineEnv, workspace: string = DEFAULT_WORKSPACE, object: string): Promise<Result<KeyProposal>> {
  return toResult(async () => {
    const d = (await getDraft(env, workspace)).draft;
    const cls = mustCls(d, object);
    if (!hasSources(cls.def)) throw new EngineReject(MSG.pairNoSources);
    const registry = await env.getRegistry(workspace);
    // 候选对用建议原语（不滤键未定的类）：识别正是为了定键，键未定也要有可比对象
    const proposals = await pairProposals(env, workspace);
    const pairs = proposals.filter((p) => p.class_a === object || p.class_b === object);
    const mates = pairs.map((p) => {
      const name = p.class_a === object ? p.class_b : p.class_a;
      return { name, cls: mustCls(d, name) };
    });
    const candidates = await candidatesOf(registry, cls, cls.def.identity);
    const mateCands = await Promise.all(
      mates.map(async (m) => ({ name: m.name, cls: m.cls, candidates: await candidatesOf(registry, m.cls, m.cls.def.identity) }))
    );
    const evidence = await trial(registry, cls, candidates, mateCands);
    const suggestion: KeySuggestion = await env.llm(workspace).proposeKey({ name: object, current: cls.def.identity, candidates: evidence });
    const chosen = suggestion.key !== null ? evidence.find((c) => c.name === suggestion.key) : undefined;
    return {
      object,
      key: suggestion.key,
      reason: suggestion.reason,
      hard: Boolean(chosen?.unique || chosen?.pk),
      evidence,
    };
  }, (v) => MSG.resultKeyIdentified(v.key));
}
