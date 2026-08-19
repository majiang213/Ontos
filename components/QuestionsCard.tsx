// 验收问题集：增删 + 对着引擎跑通过/失败。问数验收基准，不参与裁决。
"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "./wsClient";

export default function QuestionsCard({ onClose, showToast }: { onClose: () => void; showToast: (s: string) => void }) {
  const [items, setItems] = useState<{ id: number; question: string; status: string }[]>([]);
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [acting, setActing] = useState(false); // 增删的防连点
  const load = useCallback(async () => {
    try {
      const r = await fetch(apiUrl("/api/questions"));
      const data = await r.json();
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
                      await fetch(apiUrl("/api/questions"), { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: q.id }) });
                      await load();
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
                const r = await fetch(apiUrl("/api/questions"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: text.trim() }) });
                if (r.ok) setText("");
                else showToast("没加上");
                await load();
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
                const r = await fetch(apiUrl("/api/questions?run=1"), { method: "POST" });
                const data = await r.json();
                const failed = (data.results ?? []).filter((x: { status: string }) => x.status === "失败");
                showToast(failed.length ? `${failed.length} 条失败——回画布改对象或来源映射，再跑一遍` : `全部通过（v${data.version}）`);
                await load();
              } catch (e) {
                showToast(`网络错误：${e instanceof Error ? e.message : String(e)}`);
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
