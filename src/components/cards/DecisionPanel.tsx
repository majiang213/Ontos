// 待确认面板 —— 底中一张卡，两段解锁：先定唯一键，确认后疑似重复才展开。
// 顺序是数据依赖不是洁癖：交集率、问数匹配、阶段转化关系的配对字段都建在唯一键上，
// 键没定就裁，产出的是「合法但错误」的关系（发布闸查不出字段选得对不对）。
// 工具条入口、生成后不自动弹出（关掉可再进）；本卡替代原「唯一键抉择卡」与「疑似重复面板」两个入口。
"use client";

import { useState } from "react";
import Bezel from "./Bezel";
import PairCard from "./PairCard";
import type { PairAdvice } from "../../server/schema/verdict";

interface IdentityField {
  name: string;
  description?: string;
}

interface IdentityRow {
  name: string; // 对象名
  current: string; // 当前草稿里的唯一键（模型建议，空 = 未设置）
  fields: IdentityField[]; // 可当唯一键的字段（排除派生）
}

/** 对象 → 唯一键行：派生字段不能当唯一键，不列；没有候选字段的对象不进卡。纯函数，测试钉行为。 */
export function identityRows(objectTypes: Record<string, { identity?: string; properties: Record<string, { derived?: boolean; description?: string }> }>, names: string[]): IdentityRow[] {
  const rows: IdentityRow[] = [];
  for (const name of names) {
    const t = objectTypes[name];
    if (!t) continue;
    const fields = Object.entries(t.properties)
      .filter(([, d]) => !d.derived)
      .map(([n, d]) => ({ name: n, description: d.description }));
    if (fields.length === 0) continue;
    rows.push({ name, current: t.identity ?? "", fields });
  }
  return rows;
}

function fieldLabel(f: IdentityField): string {
  return f.description ? `${f.name}（${f.description}）` : f.name;
}

export default function DecisionPanel({
  rows,
  pairs,
  onConfirmIdentity,
  onPairDone,
  onClose,
}: {
  rows: IdentityRow[];
  pairs: PairAdvice[];
  onConfirmIdentity: (selections: Record<string, string>) => Promise<boolean>; // false = 没落成，卡住不解锁
  onPairDone: (msg: string) => void;
  onClose: () => void;
}) {
  const [sel, setSel] = useState<Record<string, string>>(() => Object.fromEntries(rows.map((r) => [r.name, r.current])));
  const [busy, setBusy] = useState(false);
  const [identityDone, setIdentityDone] = useState(false);
  const ready = rows.length > 0 && rows.every((r) => Boolean(sel[r.name])); // 空画布或还有「未设置」都不放行——键没定就裁会得出错的关系
  const unlocked = identityDone && ready; // 面板开着时新对象进卡，ready 变 false，② 收回
  return (
    <div className="float-card float-bc decide">
      <Bezel pad={0}>
        <div className="decide-head">
          <span className="decide-title">待确认</span>
          <button className="chip" aria-label="关闭" onClick={onClose}>✕</button>
        </div>

        <div className="decide-body">
          <div className="decide-kicker">① 唯一键（{rows.length} 个对象）</div>
          {rows.length === 0 && <div className="decide-empty">画布上还没有对象，先去生成或新建。</div>}
          <div className="decide-grid">
            {rows.map((r) => {
              const v = sel[r.name] ?? "";
              const suggested = Boolean(r.current) && v === r.current;
              return (
                <label key={r.name} className="decide-cell">
                  <div className="decide-cell-top">
                    <span className="decide-obj">{r.name}</span>
                    {suggested ? <span className="decide-hint">模型建议</span> : null}
                  </div>
                  <span className="decide-select">
                    <select
                      className="ctl"
                      value={v}
                      onChange={(e) => {
                        setSel((prev) => ({ ...prev, [r.name]: e.target.value }));
                        if (identityDone) setIdentityDone(false); // 改了键，②里按旧键算的候选对作废
                      }}
                    >
                      <option value="">未设置</option>
                      {r.fields.map((f) => (
                        <option key={f.name} value={f.name}>{fieldLabel(f)}</option>
                      ))}
                    </select>
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        <div className={`decide-lock${unlocked ? " is-open" : ""}`}>
          <div className="decide-lock-title">② 疑似重复</div>
          {!unlocked ? (
            <div className="decide-lock-note">先确认①唯一键，这里才展开。</div>
          ) : (
            <>
              {pairs.length === 0 && <div className="decide-empty">没有发现跨源疑似重复的对象。单源对象不用判，可以直接发布。</div>}
              {pairs.map((p) => (
                <PairCard key={`${p.class_a}|${p.class_b}`} pair={p} onDone={onPairDone} />
              ))}
            </>
          )}
        </div>

        <div className="decide-foot">
          <button
            className="btn-cta"
            disabled={busy || !ready}
            onClick={async () => {
              setBusy(true);
              try {
                if (await onConfirmIdentity(sel)) setIdentityDone(true);
              } finally {
                setBusy(false);
              }
            }}
          >
            确认唯一键
          </button>
        </div>
      </Bezel>
    </div>
  );
}
