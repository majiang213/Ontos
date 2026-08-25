// 验收问题集：增删 + 对着引擎跑通过/失败。问数验收基准，不参与裁决。
// 期望结果两种写法：纯数字（比对行数）或 字段=值（至少一行对上）。
// 失败分阶段（编译失败/执行出错/答案不符），点状态标签看原因；发布新版后旧结果标「待重跑」。
// 「对草稿跑一遍」试跑当前工作副本：结果只活在这张卡上（草稿标签），不落验收记录。
"use client";

import { useCallback, useEffect, useState } from "react";
import { apiDel, apiGet, apiPost } from "../workspaceClient";
import { Q_STATUS } from "../../server/features/acceptance/questionStatus";
import Bezel from "./Bezel";

interface QItem {
  id: number;
  question: string;
  expected?: string;
  status: string;
  detail?: string;
  version?: number;
}

export default function QuestionsCard({ onClose, showToast, version }: { onClose: () => void; showToast: (s: string) => void; version?: number }) {
  const [items, setItems] = useState<QItem[]>([]);
  const [fetchedVer, setFetchedVer] = useState(0);
  const curVer = version ?? fetchedVer; // 画布在轮询，version 属性比卡内取的新；优先用它
  const [text, setText] = useState("");
  const [expected, setExpected] = useState("");
  const [running, setRunning] = useState(false);
  const [runningId, setRunningId] = useState<number | null>(null); // 单条重跑与全量互斥
  const [acting, setActing] = useState(false); // 增删的防连点
  const [openId, setOpenId] = useState<number | null>(null); // 展开失败原因的那条
  const [draftRun, setDraftRun] = useState<Record<number, { status: string; detail: string }> | null>(null); // 草稿试跑结果：不落库，只活在这张卡上
  const [runningDraft, setRunningDraft] = useState(false);
  const [draftOpenId, setDraftOpenId] = useState<number | null>(null); // 展开草稿试跑失败原因的那条
  const load = useCallback(async () => {
    try {
      const data = await apiGet<{ questions?: QItem[]; version?: number }>("/api/questions");
      setItems(data.questions ?? []);
      setFetchedVer(data.version ?? 0);
    } catch {
      showToast("问题集读不出来");
    }
  }, [showToast]);
  // 发布新版（version 变了）后重拉列表，旧版本跑出来的标签随即标「待重跑」；草稿试跑结果随之作废
  useEffect(() => {
    setDraftRun(null);
    void load();
  }, [load, version]);

  /** 状态标签：未跑 / 待重跑（上次跑的版本落后于当前已发布）/ vN 结果。 */
  const tagOf = (q: QItem): { label: string; cls: string; hint?: string } => {
    if (q.status === Q_STATUS.pending) return { label: Q_STATUS.pending, cls: "tag" };
    if (q.version && curVer && q.version < curVer) {
      return { label: "待重跑", cls: "tag tag-warn", hint: `上次在 v${q.version} 跑，结果「${q.status}」；本体已到 v${curVer}` };
    }
    return { label: `v${q.version} ${q.status}`, cls: `tag ${q.status === Q_STATUS.pass ? "tag-ok" : "tag-warn"}` };
  };

  const runOne = async (id: number) => {
    if (running || runningId !== null || runningDraft) return;
    setRunningId(id);
    try {
      const data = await apiPost<{ results?: { status: string; detail: string }[]; version: number }>("/api/questions?run=1", { id });
      const r = data.results?.[0];
      showToast(r && r.status !== Q_STATUS.pass ? `${r.status}：${r.detail}` : `这条通过（v${data.version}）`);
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    } finally {
      setRunningId(null);
    }
  };

  return (
    <div className="float-card float-tl" style={{ top: 120, width: 440 }}>
      <Bezel>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>验收问题集</span>
          <button className="chip" aria-label="关闭" onClick={onClose}>✕</button>
        </div>
          {items.map((q) => {
            const t = tagOf(q);
            const d = draftRun?.[q.id] ?? null; // 这条的草稿试跑结果（有的话）
            return (
              <div key={q.id} style={{ fontSize: 12, lineHeight: 2.2 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span style={{ flex: 1, minWidth: 0 }}>{q.question}</span>
                  <span style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                    {q.detail ? (
                      <button
                        className={t.cls}
                        style={{ border: 0, cursor: "pointer", font: "inherit" }}
                        title={t.hint ? `${t.hint}；点一下看原因` : "点一下看原因"}
                        onClick={() => setOpenId(openId === q.id ? null : q.id)}
                      >
                        {t.label}
                      </button>
                    ) : (
                      <span className={t.cls} title={t.hint}>{t.label}</span>
                    )}
                    {d ? (
                      d.detail ? (
                        <button
                          className={`tag ${d.status === Q_STATUS.pass ? "tag-ok" : "tag-warn"}`}
                          style={{ border: 0, cursor: "pointer", font: "inherit" }}
                          title="草稿试跑结果，不落验收记录；点一下看原因"
                          onClick={() => setDraftOpenId(draftOpenId === q.id ? null : q.id)}
                        >
                          草稿 {d.status}
                        </button>
                      ) : (
                        <span className={`tag ${d.status === Q_STATUS.pass ? "tag-ok" : "tag-warn"}`} title="草稿试跑结果，不落验收记录">
                          草稿 {d.status}
                        </span>
                      )
                    ) : null}
                    <button className="chip" disabled={running || runningId !== null || runningDraft} onClick={() => void runOne(q.id)}>
                      {runningId === q.id ? "跑着…" : "跑这条"}
                    </button>
                    <button
                      className="chip"
                      aria-label="删除"
                      disabled={acting}
                      onClick={async () => {
                        setActing(true);
                        try {
                          await apiDel("/api/questions", { id: q.id });
                          await load();
                        } catch {
                          showToast("没删成"); // 删除失败也要说（旧版连 r.ok 都不看，静默吞）
                        } finally {
                          setActing(false);
                        }
                      }}
                    >
                      ✕
                    </button>
                  </span>
                </div>
                {q.expected ? <div style={{ color: "var(--ink-3)", fontSize: 11, lineHeight: 1.6 }}>期望：{q.expected}</div> : null}
                {openId === q.id && q.detail ? <div style={{ color: "var(--ink-3)", fontSize: 11, lineHeight: 1.6 }}>{q.detail}</div> : null}
                {draftOpenId === q.id && d?.detail ? <div style={{ color: "var(--ink-3)", fontSize: 11, lineHeight: 1.6 }}>草稿试跑：{d.detail}</div> : null}
              </div>
            );
          })}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!text.trim() || acting) return;
              setActing(true);
              try {
                await apiPost("/api/questions", { question: text.trim(), ...(expected.trim() ? { expected: expected.trim() } : {}) });
                setText("");
                setExpected("");
                await load();
              } catch (err) {
                showToast(err instanceof Error ? err.message : "没加上"); // 期望写法不合法时后端的白话提示直接透出来
              } finally {
                setActing(false);
              }
            }}
            style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}
          >
            <input className="text-in" style={{ fontSize: 12, padding: "6px 10px" }} placeholder="加一条业务问题" value={text} onChange={(e) => setText(e.target.value)} />
            <div style={{ display: "flex", gap: 6 }}>
              <input
                className="text-in"
                style={{ flex: 1, fontSize: 12, padding: "6px 10px" }}
                placeholder="期望结果（可空）：3 或 阶段=在途"
                value={expected}
                onChange={(e) => setExpected(e.target.value)}
              />
              <button type="submit" className="btn" style={{ fontSize: 12 }} disabled={acting}>加一条</button>
            </div>
          </form>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button
              className="btn-cta"
              style={{ fontSize: 12, padding: "6px 16px" }}
              disabled={running || runningId !== null || runningDraft}
              onClick={async () => {
                if (running) return; // 防连点：连跑多遍没意义
                setRunning(true);
                try {
                  const data = await apiPost<{ results?: { status: string }[]; version: number }>("/api/questions?run=1");
                  const failed = (data.results ?? []).filter((x) => x.status !== Q_STATUS.pass);
                  showToast(failed.length ? `${failed.length} 条失败——回画布改对象或来源映射，再跑一遍` : `全部通过（v${data.version}）`);
                  await load();
                } catch (e) {
                  showToast(e instanceof Error ? e.message : String(e));
                } finally {
                  setRunning(false);
                }
              }}
            >
              {running ? "跑着…" : "全量跑一遍"}
            </button>
            <button
              className="btn"
              style={{ fontSize: 12, padding: "6px 16px" }}
              title="拿当前工作副本（未发布的改动）试跑，结果只留在这张卡上，不动验收记录"
              disabled={running || runningId !== null || runningDraft}
              onClick={async () => {
                if (runningDraft) return;
                setRunningDraft(true);
                try {
                  const data = await apiPost<{ results?: { id: number; status: string; detail: string }[]; version: number | null }>("/api/questions?run=1&target=draft");
                  const rs = data.results ?? [];
                  setDraftRun(Object.fromEntries(rs.map((r) => [r.id, { status: r.status, detail: r.detail }])));
                  const failed = rs.filter((x) => x.status !== Q_STATUS.pass);
                  showToast(failed.length ? `草稿试跑：${failed.length} 条失败——改完草稿再试跑` : "草稿试跑全部通过（验收记录未动）");
                } catch (e) {
                  showToast(e instanceof Error ? e.message : String(e));
                } finally {
                  setRunningDraft(false);
                }
              }}
            >
              {runningDraft ? "试跑着…" : "对草稿跑一遍"}
            </button>
          </div>
      </Bezel>
    </div>
  );
}
