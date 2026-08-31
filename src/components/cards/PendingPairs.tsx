// 待定卡（只读）——召回提出、还没判定的疑似重复对，逐行一条带召回依据。判定回外部对话里对 Agent 说；
// 没有待定时本卡与工具条入口一起消失（没有就应该没有）。

import type { Tendency } from "../../server/schema/verdict";
import DecideCard from "./DecideCard";
import { verdictLabel } from "../canvas/sharedOrigin";

interface PendingRow {
  classes: [string, string];
  tendency: Tendency;
  reason?: string; // 召回时的机器依据（一句白话）
}

export default function PendingPairs({ pairs, drawerOpen, onClose }: {
  pairs: PendingRow[];
  drawerOpen?: boolean;
  onClose: () => void;
}) {
  return (
    <DecideCard title={`待定 ${pairs.length} 对`} drawerOpen={drawerOpen} onClose={onClose}>
      <div className="decide-kicker">
        召回按字段相似宽网捞出的对，还没判定。倾向是机器初判，不是结论；判定回外部对话里对 Agent 说。
      </div>
      <div className="decide-list">
        {pairs.map((p, i) => (
          <div key={i} className="decide-row-wrap">
            <div className="decide-row">
              <span className="decide-obj">{verdictLabel(p.tendency)}</span>
              <span>{p.classes[0]} × {p.classes[1]}</span>
            </div>
            {p.reason && <div className="decide-note">{p.reason}</div>}
          </div>
        ))}
      </div>
    </DecideCard>
  );
}
