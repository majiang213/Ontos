// 元库记录类型 —— 各关切 store 与调用方共用的行形状。

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
  options?: Record<string, unknown>;
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

/** 线端点的钉点：钉在某条边的 t 比例处（0..1）。 */
export interface BorderPinRec {
  side: "top" | "bottom" | "left" | "right";
  t: number;
}

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
