// 元库记录类型 —— 各关切 store 与调用方共用的行形状。

import type { PairAdvice } from "../schema/verdict";

export interface ConnectionRec {
  name: string;
  type: "mysql" | "pg" | "sqlite";
  host?: string;
  port?: number;
  db_name?: string;
  ro_user?: string;
  ro_pass?: string;
  rw_user?: string;
  rw_pass?: string;
}

export interface DecisionRec {
  version?: number;
  class_a: string;
  class_b: string;
  source_a: string;
  source_b: string;
  llm_advice?: string;
  rate?: number;
  evidence?: Record<string, unknown>;
  verdict: string;
  decided_by: string;
}

export interface OverlapRec {
  class_a: string;
  class_b: string;
  norm_rule?: string;
  count_a: number;
  count_b: number;
  count_hit: number;
  rate: number;
}

/** 候选对快照（adj_candidates 一行）：shot_hash 是投喂形状的哈希，proposals 是过筛后的候选对。
 *  class_names 是拍快照时有源类名，哈希失配时用来分辨「并类/立公共对象」还是「加了新类/改了字段」。
 *  class_hashes 是每个类拍快照时的内容指纹（增量召回的记忆）：内容指纹没变的类不再重问，改动类才增量重问。 */
export interface CandidateSnapshotRec {
  shot_hash: string;
  proposals: PairAdvice[];
  class_names?: string[];
  class_hashes?: Record<string, string>;
}

export interface QueryLogRec {
  version?: number;
  session_id?: string;
  model?: string;
  question?: string;
  query_json?: string;
  row_count?: number;
  error?: string;
  duration_ms?: number;
  ok: boolean;
}

/** 线端点的钉点：类型单源在 schema/ops（z.infer<borderPinSchema>），此处不再另定义。 */

export interface ActionLogRec {
  version?: number;
  action: string;
  object_type: string;
  subject: string;
  request_json?: string;
  projections?: unknown;
  error?: string;
  duration_ms?: number;
  ok: boolean;
}
