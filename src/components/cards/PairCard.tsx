// 疑似重复里的一对：先选结论；类等价再问留下谁，生命周期再问谁早谁晚。
// 顺序进 POST 的 class_a/class_b：类等价留下 a 并把 b 并进去；生命周期 a 早 b 晚。
"use client";

import { useEffect, useState } from "react";
import type { PairAdvice } from "../../server/schema/verdict";
import { VERDICTS, VERDICT_LABELS, Verdict } from "../../server/schema/verdict";
import { apiPost } from "../workspaceClient";

/** 交集率响应（/api/compute_overlap）：count_a 跟着请求里的 class_a。 */
interface OverlapResp {
  class_a: string;
  class_b: string;
  rate: number;
  count_a: number;
  count_b: number;
  count_hit: number;
  norm_rule?: string;
}

/** 把交集率响应按类名对齐到给定顺序：对得上换条数归属，对不上返回 null（类名对不上 = 让别人重算）。 */
function alignRate(r: OverlapResp, order: [string, string]): OverlapResp | null {
  if (r.class_a === order[0] && r.class_b === order[1]) return r;
  if (r.class_a === order[1] && r.class_b === order[0]) return { ...r, class_a: order[0], class_b: order[1], count_a: r.count_b, count_b: r.count_a };
  return null;
}

const HINTS: Record<Verdict, string> = {
  [Verdict.Same]: "两个类描述同一种东西。写成一个对象，挂多个来源。点了之后还要选留下谁。",
  [Verdict.Overlap]: "同一种东西里，个体有交集又不是同一批。要对得上号。会立一个公共对象。",
  [Verdict.Stage]: "同一个体的不同时期（如在途设备到在役设备）。并成一个对象，自动加状态字段和「转为晚阶段」动作。点了之后还要选谁早、谁晚。",
  [Verdict.NameSimilar]: "不是同一种东西。各自独立。会写进本体，画布上互相标出来。对得上号的话，数据不支持这一条。",
  [Verdict.Skip]: "这次不判，先放着。",
};

export default function PairCard({ pair, onDone }: { pair: PairAdvice; onDone: (msg: string) => void }) {
  const [order, setOrder] = useState<[string, string]>([pair.class_a, pair.class_b]);
  const [rate, setRate] = useState<OverlapResp | null>(null);
  const [advice, setAdvice] = useState<PairAdvice>(pair);
  const [seenOverlap, setSeenOverlap] = useState(false);
  const [stage, setStage] = useState({ from: "", to: "" });
  const [step, setStep] = useState<null | "same" | "stage">(null);
  const [busy, setBusy] = useState(false);
  const [rateBusy, setRateBusy] = useState(false);
  const [adviseBusy, setAdviseBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOrder([pair.class_a, pair.class_b]);
    setRate(null);
    setAdvice(pair);
    setSeenOverlap(false);
    setStage({ from: "", to: "" });
    setStep(null);
    setRateBusy(false);
    setAdviseBusy(false);
    setError(null);
  }, [pair.class_a, pair.class_b, pair.tendency, pair.reason]);

  const applyOrder = (keep: string): [string, string] => {
    const next: [string, string] = keep === order[0] ? order : [order[1], order[0]];
    setOrder(next);
    if (rate) setRate(alignRate(rate, next));
    return next;
  };

  const decide = async (verdict: Verdict, ord: [string, string] = order, stageNames = stage) => {
    setBusy(true);
    setError(null);
    try {
      const data = await apiPost<{ recorded?: boolean }>("/api/decide", {
        class_a: ord[0],
        class_b: ord[1],
        verdict,
        stage_names: verdict === Verdict.Stage && stageNames.from && stageNames.to ? stageNames : undefined,
        llm_advice: `${VERDICT_LABELS[advice.tendency]}：${advice.reason}`,
        evidence: rate ?? undefined,
      });
      onDone(
        verdict === Verdict.Stage
          ? `已裁决 ${ord[0]} × ${ord[1]}：并成一个对象，加了状态字段和「转为${stageNames.to}」动作（进草稿，发布后生效）${data.recorded === false ? "；注意：留痕没写进库" : ""}`
          : verdict === Verdict.Same || verdict === Verdict.Overlap || verdict === Verdict.NameSimilar
            ? `已裁决 ${ord[0]} × ${ord[1]}：${VERDICT_LABELS[verdict]}（进草稿，发布后生效）${data.recorded === false ? "；注意：留痕没写进库" : ""}`
            : ""
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = (v: Verdict) => {
    if (busy) return;
    if (v === Verdict.Same) {
      setStep("same");
      return;
    }
    if (v === Verdict.Stage) {
      setStep("stage");
      return;
    }
    setStep(null);
    void decide(v);
  };

  return (
    <div className="pair">
      <div className="pair-names">
        <code>{pair.class_a}</code>
        <span className="pair-and">和</span>
        <code>{pair.class_b}</code>
      </div>
      <div className="pair-ev">
        <span className="pair-ev-k">
          {adviseBusy ? "正在看" : seenOverlap ? (advice.tendency !== pair.tendency ? `改口（原建议${VERDICT_LABELS[pair.tendency]}）` : "看过交集率") : pair.pending ? "还该问" : "AI 建议"}
        </span>
        <div className="pair-ev-v">
          {!pair.pending && <span className="pair-ev-badge">{VERDICT_LABELS[advice.tendency]}</span>}
          {adviseBusy ? "正看着交集率，等它改口或坚持。" : advice.reason}
        </div>
      </div>
      <div
        className={`pair-ev${
          !rate ? " is-mid" : rate.count_hit === 0 ? " is-low" : rate.rate >= 0.5 ? " is-high" : " is-mid"
        }`}
      >
        <span className="pair-ev-k">交集率</span>
        <div className="pair-ev-v">
          {rate ? (
            <>
              <span className="pair-ev-num">{(rate.rate * 100).toFixed(0)}%</span>
              {rate.count_hit} 条对得上号
              {rate.count_a === 0 || rate.count_b === 0
                ? "，有一侧还没有行，说明不了是不是同一批"
                : rate.count_hit === 0
                  ? "，现在不是同一批个体"
                  : rate.rate >= 0.5
                    ? "，现在多半是同一批个体"
                    : "，同一批里只有一部分重合"}
            </>
          ) : (
            <button
              className="chip"
              disabled={rateBusy || adviseBusy}
              onClick={async () => {
                if (rateBusy || adviseBusy) return;
                setRateBusy(true);
                setError(null);
                try {
                  const r = await apiPost<OverlapResp>("/api/compute_overlap", { class_a: order[0], class_b: order[1] });
                  const aligned = alignRate(r, order);
                  setRate(aligned);
                  setRateBusy(false);
                  if (!aligned) return;
                  setAdviseBusy(true);
                  try {
                    const next = await apiPost<PairAdvice>("/api/propose_pair", {
                      class_a: aligned.class_a,
                      class_b: aligned.class_b,
                      rate: aligned.rate,
                      count_a: aligned.count_a,
                      count_b: aligned.count_b,
                      count_hit: aligned.count_hit,
                    });
                    setAdvice(next);
                    setSeenOverlap(true);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setAdviseBusy(false);
                  }
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                  setRateBusy(false);
                }
              }}
            >
              {rateBusy ? "算着…" : "算一算交集率"}
            </button>
          )}
        </div>
      </div>

      <div className="pair-q">它们是什么关系？</div>
      <div>
        {VERDICTS.map((v) => (
          <div
            key={v}
            className={`verdict-row${(step === "same" && v === Verdict.Same) || (step === "stage" && v === Verdict.Stage) ? " is-on" : ""}`}
            role="button"
            tabIndex={0}
            aria-disabled={busy}
            onClick={() => pick(v)}
            onKeyDown={(e) => {
              if (busy) return;
              if (e.key === "Enter" || e.key === " ") pick(v);
            }}
          >
            <span className="verdict-name">{VERDICT_LABELS[v]}</span>
            {!adviseBusy && !pair.pending && v === advice.tendency && <span className="verdict-suggest">建议</span>}
            <span className="verdict-hint">{HINTS[v]}</span>
          </div>
        ))}
      </div>

      {step === "same" && (
        <div className="pair-next">
          <div className="pair-next-q">留下哪一个？另一个并进来。</div>
          {[pair.class_a, pair.class_b].map((name) => (
            <button
              key={name}
              className="btn"
              disabled={busy}
              onClick={() => void decide(Verdict.Same, applyOrder(name))}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {step === "stage" && (
        <div className="pair-next">
          <div className="pair-next-q">哪个时期更早？</div>
          {[pair.class_a, pair.class_b].map((name) => (
            <button
              key={name}
              className={`btn${order[0] === name ? " is-on" : ""}`}
              disabled={busy}
              onClick={() => applyOrder(name)}
            >
              {name}
            </button>
          ))}
          <div className="pair-stage-fields">
            <span>早</span>
            <input className="ctl" placeholder="in_transit" value={stage.from} onChange={(e) => setStage({ ...stage, from: e.target.value })} />
            <span>晚</span>
            <input className="ctl" placeholder="in_service" value={stage.to} onChange={(e) => setStage({ ...stage, to: e.target.value })} />
            <button
              className="btn-cta"
              disabled={busy || !stage.from || !stage.to}
              onClick={() => void decide(Verdict.Stage)}
            >
              定案
            </button>
          </div>
          <div className="pair-hint">时期名用英文小写，问数按这里填的字过滤。</div>
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
