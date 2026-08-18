// 疑似重复面板里的一对：建议 + 依据 + 交集率（按需计算）+ 五种结论。失败留在面板里可重试。
"use client";

import { useState } from "react";
import type { PairAdvice } from "../lib/engine/llmSlot";

export default function PairCard({ pair, onDone }: { pair: PairAdvice; onDone: (msg: string) => void }) {
  const [rate, setRate] = useState<{ rate: number; count_a: number; count_b: number; count_hit: number; norm_rule?: string } | null>(null);
  const [stage, setStage] = useState({ from: "", to: "" });
  const [busy, setBusy] = useState(false);
  const [rateBusy, setRateBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (verdict: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          class_a: pair.class_a,
          class_b: pair.class_b,
          verdict,
          stage_names: verdict === "阶段" && stage.from && stage.to ? stage : undefined,
          llm_advice: `${pair.tendency}：${pair.reason}`,
          evidence: rate ?? undefined, // 证据快照：归一化规则、样本量、交集数、比率
        }),
      });
      const data = await r.json();
      if (!r.ok) setError(data.error ?? "裁决被拒"); // 留在面板里，能重试
      else onDone(`已裁决 ${pair.class_a} × ${pair.class_b}：${verdict}（进草稿，发布后生效）${data.recorded === false ? "；注意：留痕没写进库" : ""}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // 五种结论的白话说明：名字是定案术语，解释是给用户扫一眼的
  const options: { v: string; hint: string }[] = [
    { v: "同一", hint: "就是同一批东西——合并成一个对象，挂多个来源" },
    { v: "部分重叠", hint: "有一部分重合——公共字段立一个公共对象，各自特有的字段留下" },
    { v: "阶段", hint: "同一批东西的不同阶段——合并成一个对象，加状态和转化动作" },
    { v: "仅名称相似", hint: "只是名字像，其实不相干——各自独立" },
    { v: "跳过", hint: "这次不判，先放着" },
  ];

  return (
    <div style={{ borderTop: "1px solid var(--hairline)", padding: "12px 0" }}>
      <div style={{ fontSize: 13 }}>
        <code>{pair.class_a}</code> × <code>{pair.class_b}</code>
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-2)", margin: "6px 0 2px" }}>
        AI 建议「{pair.tendency}」，依据：{pair.reason}。
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6 }}>建议只是参考——起名像不像会骗人，定夺要看真实数据和你。</div>
      <div style={{ fontSize: 12, color: "var(--ink-2)", margin: "4px 0" }}>
        {rate ? (
          <>
            交集率 <strong>{(rate.rate * 100).toFixed(0)}%</strong>（{pair.class_a} {rate.count_a} 条、{pair.class_b} {rate.count_b} 条，其中 {rate.count_hit} 条对得上号）
            {rate.count_hit === 0 ? "——完全对不上，多半不相干" : rate.rate >= 0.5 ? "——多半是同一批" : ""}
          </>
        ) : (
          <button
            className="chip"
            disabled={rateBusy}
            onClick={async () => {
              if (rateBusy) return; // 交集是内存集合运算，连点没意义
              setRateBusy(true);
              setError(null);
              try {
                const r = await fetch("/api/overlap", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ class_a: pair.class_a, class_b: pair.class_b }),
                });
                const data = await r.json();
                if (r.ok) setRate(data);
                else setError(data.error ?? "算不了");
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setRateBusy(false);
              }
            }}
          >
            {rateBusy ? "算着…" : "算一算交集率"}
          </button>
        )}
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>交集率 = 两边识别字段的取值有多少对得上号（内存里算，不搬数据出库）。</div>
      <div style={{ fontSize: 12, color: "var(--ink-2)", margin: "10px 0 4px" }}>是同一批现实对象吗？选一个结论：</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {options.map((o) => (
          <div key={o.v} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
            <button
              className="chip"
              style={{ minWidth: 76, textAlign: "center" }}
              disabled={busy || (o.v === "阶段" && (!stage.from || !stage.to))}
              onClick={() => decide(o.v)}
            >
              {o.v}
            </button>
            <span style={{ color: "var(--ink-3)" }}>{o.hint}</span>
            {o.v === "阶段" && (
              <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                <input placeholder="前阶段，如：在途" value={stage.from} onChange={(e) => setStage({ ...stage, from: e.target.value })} style={{ width: 110, fontSize: 12, padding: "3px 8px", borderRadius: 8, border: "none", boxShadow: "inset 0 0 0 1px var(--hairline-strong)", background: "var(--panel-2)" }} />
                <span style={{ color: "var(--ink-3)" }}>→</span>
                <input placeholder="后阶段，如：在役" value={stage.to} onChange={(e) => setStage({ ...stage, to: e.target.value })} style={{ width: 110, fontSize: 12, padding: "3px 8px", borderRadius: 8, border: "none", boxShadow: "inset 0 0 0 1px var(--hairline-strong)", background: "var(--panel-2)" }} />
              </span>
            )}
          </div>
        ))}
      </div>
      {error && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 6 }}>{error}</div>}
    </div>
  );
}
