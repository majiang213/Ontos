// 疑似重复里的一对：人只点关系类型。留下谁、谁早谁晚、时期名走建议里的可执行方案（executionPlan）。
"use client";

import { useEffect, useState } from "react";
import type { PairAdvice } from "../../server/schema/verdict";
import { VERDICTS, VERDICT_LABELS, Verdict, executionPlan } from "../../server/schema/verdict";
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
  [Verdict.Same]: "两个类描述同一种东西。写成一个对象，挂多个来源。留下哪一个由建议给出。",
  [Verdict.Overlap]: "同一种东西里，个体有交集又不是同一批。要对得上号。会立一个公共对象。",
  [Verdict.Stage]: "同一个体的不同时期（如在途设备到在役设备）。并成一个对象，自动加状态字段和「转为晚阶段」动作。谁早谁晚、时期名由建议给出。",
  [Verdict.NameSimilar]: "不是同一种东西。各自独立。会写进本体，画布上互相标出来。对得上号的话，数据不支持这一条。",
  [Verdict.Skip]: "这次不判，先放着。",
};

export default function PairCard({ pair, onDone }: { pair: PairAdvice; onDone: (msg: string) => void }) {
  const names: [string, string] = [pair.class_a, pair.class_b];
  const [rate, setRate] = useState<OverlapResp | null>(null);
  const [advice, setAdvice] = useState<PairAdvice>(pair);
  const [seenOverlap, setSeenOverlap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rateBusy, setRateBusy] = useState(false);
  const [adviseBusy, setAdviseBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRate(null);
    setAdvice(pair);
    setSeenOverlap(false);
    setRateBusy(false);
    setAdviseBusy(false);
    setError(null);
  }, [pair.class_a, pair.class_b, pair.tendency, pair.reason, pair.keep, pair.stage?.earlier, pair.stage?.from, pair.stage?.to]);

  const decide = async (verdict: Verdict) => {
    setBusy(true);
    setError(null);
    const plan = executionPlan(pair.class_a, pair.class_b, verdict, advice);
    const [class_a, class_b] = plan.order;
    try {
      const data = await apiPost<{ recorded?: boolean }>("/api/decide", {
        class_a,
        class_b,
        verdict,
        stage_names: verdict === Verdict.Stage ? plan.stage : undefined,
        llm_advice: `${VERDICT_LABELS[advice.tendency]}：${advice.reason}`,
        evidence: rate ? (alignRate(rate, plan.order) ?? rate) : undefined,
      });
      const note = data.recorded === false ? "；注意：留痕没写进库" : "";
      onDone(
        verdict === Verdict.Stage
          ? `已裁决 ${class_a} × ${class_b}：并成一个对象，加了状态字段和「转为${plan.stage?.to}」动作（进草稿，发布后生效）${note}`
          : verdict === Verdict.Same
            ? `已裁决 ${class_a} × ${class_b}：${VERDICT_LABELS[verdict]}（留下 ${class_a}，进草稿，发布后生效）${note}`
            : verdict === Verdict.Overlap || verdict === Verdict.NameSimilar
              ? `已裁决 ${class_a} × ${class_b}：${VERDICT_LABELS[verdict]}（进草稿，发布后生效）${note}`
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
    void decide(v);
  };

  // 将落地的词（所见即所得）：生命周期按钮可点，落什么词就得看得见——从 executionPlan 取，
  // 建议带词显示建议词，缺词显示引擎占位（可改标识）。建议不倾向生命周期时也常显，前缀点明是按钮的落点。
  const stagePlan = !pair.pending ? executionPlan(pair.class_a, pair.class_b, Verdict.Stage, advice) : undefined;
  const fallbackStage = Boolean(stagePlan && (!advice.stage?.from || !advice.stage?.to));
  const planParts: string[] = [];
  if (!pair.pending && advice.tendency === Verdict.Same && advice.keep) planParts.push(`合并留下 ${advice.keep}`);
  if (stagePlan?.stage) {
    const words = `${stagePlan.order[0]} 更早（${stagePlan.stage.from} → ${stagePlan.stage.to}）${fallbackStage ? "；占位词，可改标识" : ""}`;
    planParts.push(advice.tendency === Verdict.Stage ? words : `点「${VERDICT_LABELS[Verdict.Stage]}」会落：${words}`);
  }
  const planLine = planParts.length > 0 ? planParts.join("；") : null;

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
          {adviseBusy ? "正看着交集率。" : advice.reason}
          {planLine && !adviseBusy ? ` ${planLine}` : null}
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
                  const r = await apiPost<OverlapResp>("/api/compute_overlap", { class_a: names[0], class_b: names[1] });
                  const aligned = alignRate(r, names);
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
            className="verdict-row"
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

      {error && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
