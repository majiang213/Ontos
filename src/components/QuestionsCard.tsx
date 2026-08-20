// 验收问题集：增删 + 对着引擎跑通过/失败。问数验收基准，不参与裁决。
"use client";

import { useCallback, useEffect, useState } from "react";
import { apiDel, apiGet, apiPost } from "./wsClient";

export default function QuestionsCard({ onClose, showToast }: { onClose: () => void; showToast: (s: string) => void }) {
  const [items, setItems] = useState<{ id: number; question: string; status: string }[]>([]);
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [acting, setActing] = useState(false); // 增删的防连点
  const load = useCallback(async () => {
    try {
      const data = await apiGet<{ questions?: { id: number; question: string; status: string }[] }>("/api/questions");
      setItems(data.questions ?? []);
    } catch {
      showToast("问题集读不出来");
    }
  }, [showToast]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="float-card float-tl" style={{ top: 120, width: 360 }}>
      <div className="bezel">
        <div className="bezel-core" style={{ padding: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>验收问题集</span>
            <button className="chip" aria-label="关闭" onClick={onClose}>✕</button>
          </div>
          {items.map((q) => (
            <div key={q.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, lineHeight: 2.2 }}>
              <span>{q.question}</span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span className={`tag ${q.status === "通过" ? "tag-ok" : q.status === "失败" ? "tag-warn" : ""}`}>{q.status}</span>
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
          ))}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!text.trim() || acting) return;
              setActing(true);
              try {
                await apiPost("/api/questions", { question: text.trim() });
                setText("");
                await load();
              } catch {
                showToast("没加上");
              } finally {
                setActing(false);
              }
            }}
            style={{ display: "flex", gap: 6, marginTop: 8 }}
          >
            <input className="text-in" style={{ flex: 1, fontSize: 12, padding: "6px 10px" }} placeholder="加一条业务问题" value={text} onChange={(e) => setText(e.target.value)} />
            <button type="submit" className="btn" style={{ fontSize: 12 }} disabled={acting}>加</button>
          </form>
          <button
            className="btn-cta"
            style={{ fontSize: 12, padding: "6px 16px", marginTop: 10 }}
            disabled={running}
            onClick={async () => {
              if (running) return; // 防连点：连跑多遍没意义
              setRunning(true);
              try {
                const data = await apiPost<{ results?: { status: string }[]; version: number }>("/api/questions?run=1");
                const failed = (data.results ?? []).filter((x) => x.status === "失败");
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
        </div>
      </div>
    </div>
  );
}
