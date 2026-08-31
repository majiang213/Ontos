// 留痕卡（只读）——已落定的判定与证据。判定住裁决工作记录（adj_decision）；人不同意就在外部对话里
// 指令 Agent 改，或画布手动改；发布由人点。本卡没有按钮、不收裁决。待定对在独立的待定卡里，不进本卡。

import { Verdict } from "../../server/schema/verdict";
import DecideCard from "./DecideCard";
import { verdictLabel } from "../canvas/sharedOrigin";

export interface LogRow {
  classes: [string, string];
  verdict: Verdict;
  note?: string;
  rate?: number;
  count_hit?: number; // 两边对上的个体数（证据：compute_overlap 现算）
  fields?: Record<string, string>; // 命中的字段：每边用的唯一键属性名（按类名索引）
}

export default function DecisionLog({ rows, drawerOpen, onClose }: {
  rows: LogRow[];
  drawerOpen?: boolean;
  onClose: () => void;
}) {
  return (
    <DecideCard title="判定留痕" drawerOpen={drawerOpen} onClose={onClose}>
      {rows.length === 0 && <div className="decide-empty">还没有落定的判定。</div>}
      <div className="decide-list">
        {rows.map((r, i) => (
          <div key={i} className="decide-row-wrap">
            <div className="decide-row">
              <span className="decide-obj">{verdictLabel(r.verdict)}</span>
              <span>
                {r.classes[0]} × {r.classes[1]}
                {typeof r.rate === "number" && <span className="decide-evidence"> · 交集率 {Math.round(r.rate * 100)}%</span>}
                {typeof r.count_hit === "number" && <span className="decide-evidence"> · 对上 {r.count_hit} 条</span>}
                {r.fields && r.fields[r.classes[0]] && r.fields[r.classes[1]] && (
                  <span className="decide-evidence"> · 靠 {r.fields[r.classes[0]]} ↔ {r.fields[r.classes[1]]}</span>
                )}
              </span>
            </div>
            {r.note && <div className="decide-note">{r.note}</div>}
          </div>
        ))}
      </div>
    </DecideCard>
  );
}
