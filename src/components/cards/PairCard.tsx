// 疑似重复面板里的一对：建议 + 依据 + 交集率（按需计算）+ 五种结论。失败留在面板里可重试。
"use client";

import { useRef, useState } from "react";
import type { PairAdvice } from "../../server/engine/llmSlot";
import { VERDICTS, VERDICT_LABELS, Verdict } from "../../server/engine/adjudication/verdict";
import { apiPost } from "../wsClient";

export default function PairCard({ pair, onDone }: { pair: PairAdvice; onDone: (msg: string) => void }) {
  const [rate, setRate] = useState<{ rate: number; count_a: number; count_b: number; count_hit: number; norm_rule?: string } | null>(null);
  const [stage, setStage] = useState({ from: "", to: "" });
  const [busy, setBusy] = useState(false);
  const [rateBusy, setRateBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stageFromRef = useRef<HTMLInputElement>(null);

  const decide = async (verdict: Verdict) => {
    setBusy(true);
    setError(null);
    try {
      const data = await apiPost<{ recorded?: boolean }>("/api/decide", {
        class_a: pair.class_a,
        class_b: pair.class_b,
        verdict,
        stage_names: verdict === Verdict.Stage && stage.from && stage.to ? stage : undefined,
        llm_advice: `${VERDICT_LABELS[pair.tendency]}：${pair.reason}`,
        evidence: rate ?? undefined, // 证据快照：归一化规则、样本量、交集数、比率
      });
      onDone(
        verdict === Verdict.Stage
          ? `已裁决 ${pair.class_a} × ${pair.class_b}：并成一个对象，加了状态字段和「转为${stage.to}」动作（进草稿，发布后生效）${data.recorded === false ? "；注意：留痕没写进库" : ""}`
          : verdict === Verdict.Same || verdict === Verdict.Overlap
            ? `已裁决 ${pair.class_a} × ${pair.class_b}：${VERDICT_LABELS[verdict]}（进草稿，发布后生效）${data.recorded === false ? "；注意：留痕没写进库" : ""}`
            : "" // 仅名称相似/跳过：不动草稿，条目从面板消失即是反馈，不弹提示
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); // 留在面板里，能重试
    } finally {
      setBusy(false);
    }
  };

  // 五种结论的白话说明：名字是定案术语（VERDICT_LABELS），解释是给用户扫一眼的
  const HINTS: Record<Verdict, string> = {
    [Verdict.Same]: "就是同一批东西——合并成一个对象，挂多个来源",
    [Verdict.Overlap]: "有一部分重合——公共字段立一个公共对象，各自特有的字段留下",
    [Verdict.Stage]: "同一批东西的不同时期（如在途设备 → 在役设备）——并成一个对象，自动加状态字段和「转为晚阶段」动作",
    [Verdict.NameSimilar]: "只是名字像，其实不相干——各自独立",
    [Verdict.Skip]: "这次不判，先放着",
  };
  const options: { v: Verdict; label: string; hint: string }[] = VERDICTS.map((v) => ({ v, label: VERDICT_LABELS[v], hint: HINTS[v] }));

  return (
    <div style={{ borderTop: "1px solid var(--hairline)", padding: "14px 0 4px" }}>
      {/* 候选对 + AI 软证据 */}
      <div style={{ fontSize: 14, fontWeight: 600 }}>
        <code>{pair.class_a}</code> × <code>{pair.class_b}</code>
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 6 }}>
        AI 建议「{VERDICT_LABELS[pair.tendency]}」，依据：{pair.reason}。
        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>建议只是参考——起名像不像会骗人，定夺要看真实数据和你。</div>
      </div>
      {/* 交集率：硬证据，按需算；注解跟在同一行 */}
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", fontSize: 12, color: "var(--ink-2)", marginTop: 8 }}>
        {rate ? (
          <span>
            交集率 <strong>{(rate.rate * 100).toFixed(0)}%</strong>（{pair.class_a} {rate.count_a} 条、{pair.class_b} {rate.count_b} 条，其中 {rate.count_hit} 条对得上号）
            {rate.count_hit === 0 ? "——完全对不上，多半不相干" : rate.rate >= 0.5 ? "——多半是同一批" : ""}
          </span>
        ) : (
          <button
            className="chip"
            disabled={rateBusy}
            onClick={async () => {
              if (rateBusy) return; // 交集是内存集合运算，连点没意义
              setRateBusy(true);
              setError(null);
              try {
                setRate(await apiPost<typeof rate>("/api/compute_overlap", { class_a: pair.class_a, class_b: pair.class_b }));
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
        <span style={{ fontSize: 11, color: "var(--ink-3)" }}>交集率 = 两边唯一键的取值有多少对得上号（内存里算，不搬数据出库）。</span>
      </div>
      {/* 结论：整宽行卡，名字在左、说明跟随，整行可点 */}
      <div style={{ fontSize: 12, color: "var(--ink-2)", margin: "14px 0 6px" }}>是同一批现实对象吗？选一个结论：</div>
      <div style={{ borderTop: "1px solid var(--hairline)" }}>
        {options.map((o) => {
          const incomplete = o.v === Verdict.Stage && (!stage.from || !stage.to); // 阶段缺参数：不置灰（输入框在行里），点击改成聚焦
          return (
            <div
              key={o.v}
              className="verdict-row"
              role="button"
              tabIndex={0}
              aria-disabled={busy}
              onClick={() => {
                if (busy) return;
                if (incomplete) {
                  stageFromRef.current?.focus();
                  return;
                }
                void decide(o.v);
              }}
              onKeyDown={(e) => {
                if (busy || incomplete) return;
                if (e.key === "Enter" || e.key === " ") void decide(o.v);
              }}
            >
              <span className="verdict-name">{o.label}</span>
              <span className="verdict-hint">{o.hint}</span>
              {o.v === Verdict.Stage && (
                <span className="verdict-stage" onClick={(e) => e.stopPropagation()}>
                    <span style={{ fontSize: 11, color: "var(--ink-3)" }}>填两个时期的名字：</span>
                    <span style={{ fontSize: 11, color: "var(--ink-3)" }}>早</span>
                    <input ref={stageFromRef} placeholder="如：在途" value={stage.from} onChange={(e) => setStage({ ...stage, from: e.target.value })} style={{ width: 96, fontSize: 12, padding: "4px 8px", borderRadius: 8, border: "1px solid var(--line-strong)", background: "var(--panel-2)" }} />
                    <span style={{ color: "var(--ink-3)" }}>→</span>
                    <span style={{ fontSize: 11, color: "var(--ink-3)" }}>晚</span>
                    <input placeholder="如：在役" value={stage.to} onChange={(e) => setStage({ ...stage, to: e.target.value })} style={{ width: 96, fontSize: 12, padding: "4px 8px", borderRadius: 8, border: "1px solid var(--line-strong)", background: "var(--panel-2)" }} />
                    <span style={{ fontSize: 11, color: "var(--ink-3)" }}>，再点本行定案</span>
                </span>
              )}
            </div>
          );
        })}
      </div>
      {error && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 6 }}>{error}</div>}
    </div>
  );
}
