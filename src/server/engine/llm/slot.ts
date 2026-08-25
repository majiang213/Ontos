// LLM 槽位 —— 「模型在哪几个槽位出现、没 key 怎么办」（《ontos-article.md》§4、§5.3）。
// 接口 + 槽位选择（有 OPENAI_API_KEY 走真模型，否则罐头离线回退）+ REST/MCP 组合原语。
// 实现在同目录：罐头 canned.ts（离线确定性 + 演示剧本），真模型 aiSdk.ts（提示词工程）。

import type { QueryRequest } from "../../schema/request";
import type { ObjectType, OntologyConfig } from "../../schema/config";
import type { TableInfo } from "../infra/driver";
import type { PairAdvice } from "../adjudication/verdict";
import type { DriverRegistry } from "../infra/registry";
import { resolveTableInfos } from "../infra/tables";
import { runtime } from "../../runtime";
import { MSG } from "../../errors";
import { createXai } from "@ai-sdk/xai";
import { CannedSlot } from "./canned";
import { AiSdkSlot } from "./aiSdk";

export interface LlmSlot {
  /** 实现名，留痕用（离线回退 / 真模型名） */
  readonly name: string;
  /** NL → 查询 JSON（问数槽位）。ws 说出「哪个空间在问」：罐头剧本只服务 test 空间（演示数据），
   *  没有这条论元守卫只能借 config 拐弯——任何空间恰好有同名类就会被静默编成演示查询。 */
  nlToQuery(question: string, config: OntologyConfig, ws: string): Promise<QueryRequest>;
  /** 表结构 → 本体草稿（逆向建模槽位） */
  proposeObjects(tables: { connection: string; table: TableInfo }[]): Promise<Record<string, ObjectType>>;
  /** 跨源类两两比对 → 候选对与倾向（整合槽位）。sources 是该类的连接集合（跨源判定在实现里做）。 */
  proposePairs(classes: { name: string; sources: string[]; fields: string[] }[]): Promise<PairAdvice[]>;
}

/** 槽位选择：有 OPENAI_API_KEY 走真模型（OpenAI 兼容协议，通用键同 Claude Code / Codex），实例缓存在 runtime 上；
 *  否则离线回退（CannedSlot：问数只覆盖演示剧本，逆向建模与候选对建议是通用启发式，各空间都能用）。
 *  模型必须显式指定 OPENAI_MODEL，不设默认；接入点用 OPENAI_BASE_URL，不设走 SDK 默认端点。 */
export function getSlot(): LlmSlot {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return new CannedSlot();
  const rt = runtime();
  if (!rt.llmSlot) {
    const model = process.env.OPENAI_MODEL;
    if (!model) throw new Error(MSG.openaiModelMissing);
    const xai = createXai({ apiKey: key, baseURL: process.env.OPENAI_BASE_URL ?? undefined });
    rt.llmSlot = new AiSdkSlot(xai.responses(model));
  }
  return rt.llmSlot;
}

/** 「表结构 → 对象建议」的组合原语：按连接内省定位 + 槽位产草稿。REST 与 MCP 的 propose_objects 共用；
 *  notFound 产出的错误类型由调用方定（REST 与 MCP 都传 EngineReject——路由按 422、MCP 按 -32000 映射）。 */
export async function proposeObjectsFor(
  registry: DriverRegistry,
  tables: { connection: string; table: string }[],
  notFound: (msg: string) => Error
): Promise<Record<string, ObjectType>> {
  const infos = await resolveTableInfos(registry, tables, notFound);
  return getSlot().proposeObjects(infos);
}
