// 待确认面板 —— 底中一张卡，两段解锁：先定唯一键，确认后疑似重复才展开。
// 顺序是数据依赖不是洁癖：交集率、问数匹配、阶段转化关系的配对字段都建在唯一键上，
// 键没定就裁，产出的是「合法但错误」的关系（发布闸查不出字段选得对不对）。
// 工具条入口、生成后不自动弹出（关掉可再进）；本卡替代原「唯一键抉择卡」与「疑似重复面板」两个入口。
"use client";

import { useEffect, useState } from "react";
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

/** 面板开着时对象有增删（裁「部分重叠」立公共对象、又生成新对象）时的选择同步：
 *  新行用草稿里的当前键补上——公共对象的键裁时已复制好，不该显示「未设置」把人打回①；
 *  用户已改的选择不动；从画布消失的对象清掉。纯函数，测试钉行为。 */
export function mergeSelections(sel: Record<string, string>, rows: IdentityRow[]): Record<string, string> {
  const names = new Set(rows.map((r) => r.name));
  const grown = rows.some((r) => !(r.name in sel));
  const shrank = Object.keys(sel).some((n) => !names.has(n));
  if (!grown && !shrank) return sel;
  const next: Record<string, string> = {};
  for (const r of rows) next[r.name] = r.name in sel ? sel[r.name] : r.current;
  return next;
}

/** 识别唯一键的结果（propose_key 返回的投影）：key 为 null = 没选出来；hard = 建议列带唯一约束/非整数主键。 */
export interface IdentifySuggestion {
  key: string | null;
  reason: string;
  hard: boolean;
}

/** 识别结果的证据行：一句依据 + 硬/软保证标签（key 为 null 时不挂标签）。独立组件便于渲染测试。 */
export function KeyEvidenceLine({ ev }: { ev: IdentifySuggestion }) {
  return (
    <div className="decide-key-evidence">
      <span>{ev.reason}</span>
      {ev.key !== null && <span className={`tag${ev.hard ? " is-hard" : " is-soft"}`}>{ev.hard ? "硬保证" : "软保证"}</span>}
    </div>
  );
}

export default function DecisionPanel({
  rows,
  pairs,
  drawerOpen,
  onConfirmIdentity,
  onPairDone,
  onIdentify,
  onClose,
}: {
  rows: IdentityRow[];
  pairs: PairAdvice[];
  /** 数据源抽屉开着时面板抬到抽屉上沿之上（is-lifted，只让位置不互关）；不传 = 底中原位 */
  drawerOpen?: boolean;
  onConfirmIdentity: (selections: Record<string, string>) => Promise<boolean>; // false = 没落成，卡住不解锁
  onPairDone: (msg: string) => void;
  /** 逐类「识别唯一键」：数据试算 + 模型综合判断，只建议不落地。null = 服务端失败（调用方已提示），不动选择。 */
  onIdentify: (name: string) => Promise<IdentifySuggestion | null>;
  onClose: () => void;
}) {
  const [sel, setSel] = useState<Record<string, string>>(() => Object.fromEntries(rows.map((r) => [r.name, r.current])));
  const [busy, setBusy] = useState(false);
  const [identifying, setIdentifying] = useState<string | null>(null); // 正在识别的对象名（一次一个）
  const [identified, setIdentified] = useState<Record<string, IdentifySuggestion>>({});
  const [identityDone, setIdentityDone] = useState(false);
  useEffect(() => setSel((prev) => mergeSelections(prev, rows)), [rows]); // 面板开着时对象增删（部分重叠立公共对象、又生成对象）：新行补草稿当前键，不打回①
  const ready = rows.length > 0 && rows.every((r) => Boolean(sel[r.name])); // 空画布或还有「未设置」都不放行——键没定就裁会得出错的关系
  const unlocked = identityDone && ready; // 面板开着时新对象进卡，ready 变 false，② 收回
  return (
    <div className={`float-card float-bc decide${unlocked ? " is-pairs" : ""}${drawerOpen ? " is-lifted" : ""}`}>
      <Bezel pad={0}>
        <div className="decide-head">
          <span className="decide-title">{unlocked ? "疑似重复" : "待确认"}</span>
          <span className="decide-head-actions">
            {unlocked && (
              <button className="chip" onClick={() => setIdentityDone(false)}>改唯一键</button>
            )}
            <button className="chip" aria-label="关闭" onClick={onClose}>✕</button>
          </span>
        </div>

        {!unlocked ? (
          <>
            <div className="decide-body">
              <div className="decide-kicker">① 唯一键（{rows.length} 个对象）</div>
              {rows.length === 0 && <div className="decide-empty">画布上还没有对象，先去生成或新建。</div>}
              <div className="decide-list">
                {rows.map((r) => {
                  const v = sel[r.name] ?? "";
                  const suggested = Boolean(r.current) && v === r.current;
                  const ev = identified[r.name];
                  return (
                    <div key={r.name} className="decide-row-wrap">
                      <label className="decide-row">
                        <span className="decide-obj">{r.name}</span>
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
                        <span className="decide-hint">{suggested ? "模型建议" : ""}</span>
                      </label>
                      <div className="decide-row-tools">
                        {ev ? (
                          <KeyEvidenceLine ev={ev} />
                        ) : (
                          <button
                            className="chip"
                            disabled={identifying !== null}
                            onClick={async () => {
                              setIdentifying(r.name);
                              try {
                                const s = await onIdentify(r.name);
                                if (s) {
                                  setIdentified((prev) => ({ ...prev, [r.name]: s }));
                                  const k = s.key;
                                  if (k) setSel((prev) => ({ ...prev, [r.name]: k })); // 建议预选，确认才落库
                                }
                              } finally {
                                setIdentifying(null);
                              }
                            }}
                          >
                            {identifying === r.name ? "识别中…" : "识别唯一键"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="decide-lock">
              <div className="decide-lock-title">② 疑似重复</div>
              <div className="decide-lock-note">先确认①唯一键，这里才展开。</div>
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
          </>
        ) : (
          <div className="decide-body decide-pairs-body">
            {pairs.length === 0 && <div className="decide-empty">没有发现疑似重复的对象，可以直接发布。</div>}
            {pairs.length > 0 && (
              <>
                {pairs.length > 1 && <div className="decide-kicker">还剩 {pairs.length} 对</div>}
                <PairCard key={`${pairs[0].class_a}|${pairs[0].class_b}`} pair={pairs[0]} onDone={onPairDone} />
              </>
            )}
          </div>
        )}
      </Bezel>
    </div>
  );
}
