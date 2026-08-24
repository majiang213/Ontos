// 平台元数据库门面 —— MetaStore：按关切分簇的窄入口，方法委托给 stores/ 下的关切 store。
// 存储模型与后端可换（SQLite 单文件 / MySQL）见 ./backends；记录类型见 ./types。
// workspace_id 的过滤纪律收在各关切 store 的基座（stores/base.ts）：方法第一个参数就是空间名，调用方不碰 SQL。

import { join } from "node:path";
import { runtime } from "../runtime";
import { MysqlBackend, SqliteBackend, type MetaBackend } from "./backends";
import { AdjudicationStore } from "./stores/adjudication";
import { ConnectionsStore } from "./stores/connections";
import { LogsStore } from "./stores/logs";
import { QuestionsStore } from "./stores/questions";
import { SeqStore } from "./stores/seq";
import { VersionChainStore } from "./stores/versionChain";
import { WorkspacesStore } from "./stores/workspaces";
import type { ActionLogRec, ConnectionRec, DecisionRec, OverlapRec, QueryLogRec } from "./types";

export class MetaStore {
  private workspaces: WorkspacesStore;
  private versions: VersionChainStore;
  private conns: ConnectionsStore;
  private adjudication: AdjudicationStore;
  private questions: QuestionsStore;
  private logs: LogsStore;
  private seq: SeqStore;

  constructor(private backend: MetaBackend) {
    this.workspaces = new WorkspacesStore(backend);
    this.versions = new VersionChainStore(backend);
    this.conns = new ConnectionsStore(backend);
    this.adjudication = new AdjudicationStore(backend);
    this.questions = new QuestionsStore(backend);
    this.logs = new LogsStore(backend);
    this.seq = new SeqStore(backend);
  }

  async close() {
    await this.backend.close();
  }

  /* 工作空间（注册表） */
  listWorkspaces() {
    return this.workspaces.listWorkspaces();
  }
  ensureWorkspace(name: string, seedYaml: string, seedFrom = "template") {
    return this.workspaces.ensureWorkspace(name, seedYaml, seedFrom);
  }

  /* 版本链与工作行 */
  latestVersion(ws: string, seedYaml: string) {
    return this.versions.latestVersion(ws, seedYaml);
  }
  insertVersion(ws: string, version: number, yaml: string, origin: "publish", canvas?: unknown) {
    return this.versions.insertVersion(ws, version, yaml, origin, canvas);
  }
  listVersions(ws: string) {
    return this.versions.listVersions(ws);
  }
  versionYaml(ws: string, version: number) {
    return this.versions.versionYaml(ws, version);
  }
  versionCanvas(ws: string, version: number) {
    return this.versions.versionCanvas(ws, version);
  }
  getWorkingPack(ws: string) {
    return this.versions.getWorkingPack(ws);
  }
  setWorkingPack(ws: string, pack: unknown) {
    return this.versions.setWorkingPack(ws, pack);
  }

  /* 连接 */
  saveConnection(ws: string, c: ConnectionRec) {
    return this.conns.saveConnection(ws, c);
  }
  listConnections(ws: string) {
    return this.conns.listConnections(ws);
  }
  deleteConnection(ws: string, name: string) {
    return this.conns.deleteConnection(ws, name);
  }

  /* 裁决与交集 */
  recordDecision(ws: string, d: DecisionRec) {
    return this.adjudication.recordDecision(ws, d);
  }
  listDecisions(ws: string) {
    return this.adjudication.listDecisions(ws);
  }
  backfillDecisionVersions(ws: string, version: number) {
    return this.adjudication.backfillDecisionVersions(ws, version);
  }
  abandonPendingDecisions(ws: string) {
    return this.adjudication.abandonPendingDecisions(ws);
  }
  recordOverlap(ws: string, o: OverlapRec) {
    return this.adjudication.recordOverlap(ws, o);
  }
  listOverlaps(ws: string) {
    return this.adjudication.listOverlaps(ws);
  }

  /* 验收问题集 */
  listQuestions(ws: string) {
    return this.questions.listQuestions(ws);
  }
  addQuestion(ws: string, question: string, expected?: string) {
    return this.questions.addQuestion(ws, question, expected);
  }
  removeQuestion(ws: string, qid: number) {
    return this.questions.removeQuestion(ws, qid);
  }
  setQuestionStatus(ws: string, qid: number, status: string, version?: number, detail?: string) {
    return this.questions.setQuestionStatus(ws, qid, status, version, detail);
  }

  /* 日志（不存结果集） */
  logQuery(ws: string, l: QueryLogRec) {
    return this.logs.logQuery(ws, l);
  }
  logAction(ws: string, l: ActionLogRec) {
    return this.logs.logAction(ws, l);
  }
  listQueryLogs(ws: string, limit?: number) {
    return this.logs.listQueryLogs(ws, limit);
  }
  listActionLogs(ws: string, limit?: number) {
    return this.logs.listActionLogs(ws, limit);
  }

  /* 发号器 */
  nextSeq(ws: string, name: string, start?: number) {
    return this.seq.nextSeq(ws, name, start);
  }
}

/* ---------- 单例（挂在 Runtime 上；一个共享后端，不按空间分实例） ---------- */

/** 共享元库入口。ONTOS_META_DSN=mysql://… 走 MySQL，否则离线单文件 SQLite（路径取运行态的 cwd）。 */
export function metaStore(): MetaStore {
  const rt = runtime();
  rt.meta ??= new MetaStore(rt.metaDsn ? new MysqlBackend(rt.metaDsn) : new SqliteBackend(join(rt.cwd, "src/server/config/ontos-meta.db")));
  return rt.meta;
}

/** 测试用：独立临时库（SQLite 后端）。 */
export function freshMetaStore(path: string): MetaStore {
  return new MetaStore(new SqliteBackend(path));
}
