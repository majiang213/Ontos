// 平台元数据库门面 —— MetaStore：按关切分簇的窄入口，方法委托给 stores/ 下的关切 store。
// 存储模型与数据库可换（SQLite 单文件 / MySQL / PG）见 ./datasource；记录类型见 ./types。
// workspace_id 的过滤纪律收在各关切 store 的基座（stores/base.ts）：方法第一个参数就是空间名，调用方不碰 SQL。

import { join } from "node:path";
import { runtime } from "../runtime";
import { openMetaDatasource, SqliteDatasource, type MetaDatasource } from "./datasource";
import { AdjudicationStore } from "./stores/adjudication";
import { ConnectionsStore } from "./stores/connections";
import { LogsStore } from "./stores/logs";
import { QuestionsStore } from "./stores/questions";
import { VersionChainStore } from "./stores/versionChain";
import { WorkspacesStore } from "./stores/workspaces";
import type { ActionLogRec, CandidateSnapshotRec, ConnectionRec, DecisionRec, OverlapRec, QueryLogRec } from "./types";

export class MetaStore {
  private workspaces: WorkspacesStore;
  private versions: VersionChainStore;
  private conns: ConnectionsStore;
  private adjudication: AdjudicationStore;
  private questions: QuestionsStore;
  private logs: LogsStore;

  constructor(private datasource: MetaDatasource) {
    this.workspaces = new WorkspacesStore(datasource);
    this.versions = new VersionChainStore(datasource);
    this.conns = new ConnectionsStore(datasource);
    this.adjudication = new AdjudicationStore(datasource);
    this.questions = new QuestionsStore(datasource);
    this.logs = new LogsStore(datasource);
  }

  async close() {
    await this.datasource.close();
  }

  /* 工作空间（注册表） */
  listWorkspaces() {
    return this.workspaces.listWorkspaces();
  }
  ensureWorkspace(name: string, seedYaml: string, seedFrom = "template") {
    return this.workspaces.ensureWorkspace(name, seedYaml, seedFrom);
  }

  /* 版本链与工作行 */
  latestVersion(workspace: string, seedYaml: string) {
    return this.versions.latestVersion(workspace, seedYaml);
  }
  insertVersion(workspace: string, version: number, yaml: string, origin: "publish", canvas?: unknown) {
    return this.versions.insertVersion(workspace, version, yaml, origin, canvas);
  }
  listVersions(workspace: string) {
    return this.versions.listVersions(workspace);
  }
  versionYaml(workspace: string, version: number) {
    return this.versions.versionYaml(workspace, version);
  }
  versionCanvas(workspace: string, version: number) {
    return this.versions.versionCanvas(workspace, version);
  }
  getDraftPack(workspace: string) {
    return this.versions.getDraftPack(workspace);
  }
  saveDraftPack(workspace: string, pack: unknown, expectedRev: number, bump: boolean) {
    return this.versions.saveDraftPack(workspace, pack, expectedRev, bump);
  }

  /* 连接 */
  saveConnection(workspace: string, c: ConnectionRec) {
    return this.conns.saveConnection(workspace, c);
  }
  listConnections(workspace: string) {
    return this.conns.listConnections(workspace);
  }
  deleteConnection(workspace: string, name: string) {
    return this.conns.deleteConnection(workspace, name);
  }

  /* 裁决与交集 */
  recordDecision(workspace: string, d: DecisionRec) {
    return this.adjudication.recordDecision(workspace, d);
  }
  listDecisions(workspace: string) {
    return this.adjudication.listDecisions(workspace);
  }
  backfillDecisionVersions(workspace: string, version: number) {
    return this.adjudication.backfillDecisionVersions(workspace, version);
  }
  abandonPendingDecisions(workspace: string) {
    return this.adjudication.abandonPendingDecisions(workspace);
  }
  recordOverlap(workspace: string, o: OverlapRec) {
    return this.adjudication.recordOverlap(workspace, o);
  }
  listOverlaps(workspace: string) {
    return this.adjudication.listOverlaps(workspace);
  }
  readCandidateSnapshot(workspace: string) {
    return this.adjudication.readCandidateSnapshot(workspace);
  }
  writeCandidateSnapshot(workspace: string, snap: CandidateSnapshotRec) {
    return this.adjudication.writeCandidateSnapshot(workspace, snap);
  }

  /* 验收问题集 */
  listQuestions(workspace: string) {
    return this.questions.listQuestions(workspace);
  }
  addQuestion(workspace: string, question: string, expected?: string) {
    return this.questions.addQuestion(workspace, question, expected);
  }
  removeQuestion(workspace: string, qid: number) {
    return this.questions.removeQuestion(workspace, qid);
  }
  setQuestionStatus(workspace: string, qid: number, status: string, version?: number, detail?: string) {
    return this.questions.setQuestionStatus(workspace, qid, status, version, detail);
  }

  /* 日志（不存结果集） */
  logQuery(workspace: string, l: QueryLogRec) {
    return this.logs.logQuery(workspace, l);
  }
  logAction(workspace: string, l: ActionLogRec) {
    return this.logs.logAction(workspace, l);
  }
  listQueryLogs(workspace: string, limit?: number) {
    return this.logs.listQueryLogs(workspace, limit);
  }
  listActionLogs(workspace: string, limit?: number) {
    return this.logs.listActionLogs(workspace, limit);
  }
}

/* ---------- 单例（挂在 Runtime 上；一个共享后端，不按空间分实例） ---------- */

/** 共享元库入口。不设 DSN = 离线单文件 SQLite；mysql:// 走 MySQL；postgres:// / postgresql:// 走 PG（路径取运行态的 cwd）。 */
export function metaStore(): MetaStore {
  const rt = runtime();
  rt.meta ??= new MetaStore(openMetaDatasource(rt.metaDsn, join(rt.cwd, "src/server/config/ontos-meta.db")));
  return rt.meta;
}

/** 测试用：独立临时库（SQLite 后端）。 */
export function freshMetaStore(path: string): MetaStore {
  return new MetaStore(new SqliteDatasource(path));
}
