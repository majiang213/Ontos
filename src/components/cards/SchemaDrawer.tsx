// 数据源抽屉（底部两栏）：左栏管源——已接入的源点选切换、演示库文件一按接入、手动填只读连接；
// 右栏看选中源的列定义与 REST 已带回的 3 行脱敏采样（值已是 maskValue 之后的，不再二次脱敏；空数组写「没有行」），
// 勾选表 → 生成对象直接上画布并收起（勾选跨源保留：切源只换右栏视图，全选并上本源、清空一次清全部）。
// 表永远是原料，不上画布；采样只给人看，不进生成 prompt。
"use client";

import { useEffect, useState } from "react";
import Bezel from "./Bezel";
import { ConnectForm } from "../forms/forms";
import { apiGet, apiPost } from "../workspaceClient";

interface TableCol {
  name: string;
  type: string;
  pk: boolean;
  comment?: string;
}

interface SourceFile {
  file: string;
  path: string;
  title?: string;
  connection: string;
  connected: boolean;
}

export default function SchemaDrawer({
  schema,
  columnTarget,
  onGenerate,
  onConnected,
  showToast,
}: {
  schema: { sources: { connection: string; error?: string; tables: { name: string; columns: TableCol[]; sample?: Record<string, unknown>[] }[] }[] } | null;
  columnTarget: (connection: string, table: string, column: string) => string;
  onGenerate: (tables: { connection: string; table: string }[]) => Promise<boolean>; // true = 已落草稿，此时才清勾选
  onConnected: (msg: string) => void; // 连接落库后：页面 toast + 重拉表结构，抽屉原地更新
  showToast: (text: string) => void; // 接入失败与空库告警
}) {
  const sources = schema?.sources ?? [];
  const [sel, setSel] = useState<string | null>(null); // 右栏当前看的源；null = 跟第一个已接入的源
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<SourceFile[] | null>(null);
  const [filesTick, setFilesTick] = useState(0); // 接入后重拉可选清单（connected 位随连接变）
  const [manualOpen, setManualOpen] = useState(false);

  useEffect(() => {
    apiGet<{ files: SourceFile[] }>("/api/list_sqlite_files")
      .then((d) => setFiles(d.files))
      .catch(() => setFiles([])); // 可选清单读不出：只少了一按接入，手动路径仍在
  }, [filesTick]);

  const active = sel && sources.some((s) => s.connection === sel) ? sel : (sources[0]?.connection ?? null);
  const activeSource = sources.find((s) => s.connection === active) ?? null;
  // 该源已勾几张：按各自键集精确归属，不做连接名前缀匹配（连接名互为点前缀时会算错）
  const checkedCountOf = (s: (typeof sources)[number]) => s.tables.filter((t) => selectedTables.has(`${s.connection}.${t.name}`)).length;

  const connectOne = async (f: SourceFile) => {
    try {
      const data = await apiPost<{ saved: boolean; warning?: string; tables?: unknown[] }>("/api/connections", {
        name: f.connection,
        type: "sqlite",
        db_name: f.path,
        test: true, // 先测连通再保存（与手动接入同一原语）；空库测通但不落库
      });
      if (data.saved) {
        onConnected(`已连接 ${f.title ?? f.file}，读到 ${data.tables?.length ?? 0} 张表`);
        setFilesTick((t) => t + 1);
      } else {
        showToast(data.warning ?? `${f.title ?? f.file} 没接上：没有可连接的表`);
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  };

  const generate = async () => {
    const tables = [...selectedTables].map((key) => {
      const dot = key.indexOf("."); // 只切第一个点：连接名/表名里再有点不炸
      return { connection: key.slice(0, dot), table: key.slice(dot + 1) };
    });
    const ok = await onGenerate(tables); // 失败不清勾选：修好重发不用挨张重勾
    if (ok) setSelectedTables(new Set());
  };

  return (
    <div className="drawer">
      <div className="drawer-source-pane">
        <span className="eyebrow">已接入的源</span>
        {sources.length === 0 && <div className="drawer-src-empty">还没有接入的源——从下面挑一个演示文件，或手动填连接。</div>}
        {sources.map((s) => {
          const checked = checkedCountOf(s);
          return (
            <button
              key={s.connection}
              className={`src-row${active === s.connection ? " is-on" : ""}`}
              onClick={() => setSel(s.connection)} // 勾选跨源保留：切源只换右栏视图，不清已勾的表
            >
              <b>{s.connection}</b> · {s.tables.length} 张表
              {checked > 0 && <span className="tag" style={{ marginLeft: 6 }}>已勾 {checked}</span>}
            </button>
          );
        })}
        <div className="drawer-src-split" />
        <span className="eyebrow">可接入（演示文件）</span>
        {(files ?? []).filter((f) => !f.connected).map((f) => (
          <div key={f.connection} className="src-cand">
            <span className="src-cand-name">
              <b>{f.title ?? f.file}</b> <code>{f.connection}</code>
            </span>
            <button className="chip" onClick={() => void connectOne(f)}>
              接入
            </button>
          </div>
        ))}
        <button className="chip" style={{ marginTop: 8 }} onClick={() => setManualOpen((v) => !v)}>
          手动接入（MySQL / PG / 指定路径）
        </button>
        {manualOpen && (
          <div style={{ marginTop: 8 }}>
            <ConnectForm
              defaultManual
              onCancel={() => setManualOpen(false)}
              onDone={(msg) => {
                onConnected(msg);
                setManualOpen(false);
                setFilesTick((t) => t + 1);
              }}
            />
          </div>
        )}
      </div>

      <div className="drawer-tables-pane">
        {!activeSource && <div className="drawer-src-empty">接入一个源后，这里显示它的表结构。</div>}
        {activeSource && (
          <>
            <div className="drawer-generate-bar">
              <span className="eyebrow">{activeSource.connection}</span>
              {selectedTables.size > 0 && (
                <button className="btn-cta" onClick={generate}>
                  生成对象（{selectedTables.size} 张表）
                </button>
              )}
              <button
                className="btn"
                onClick={() =>
                  // 全选 = 并上本源全部表，不动别源已勾的
                  setSelectedTables((prev) => new Set([...prev, ...activeSource.tables.map((t) => `${activeSource.connection}.${t.name}`)]))
                }
              >
                全选（共 {activeSource.tables.length} 张表）
              </button>
              {selectedTables.size > 0 && <button className="btn" onClick={() => setSelectedTables(new Set())}>清空选择</button>}
            </div>
            <div className="drawer-table-cards">
              {activeSource.tables.map((t) => {
                const key = `${activeSource.connection}.${t.name}`;
                const checked = selectedTables.has(key);
                return (
                  <Bezel key={t.name} pad={12} style={{ minWidth: 260, outline: checked ? "2px solid var(--accent)" : "none", outlineOffset: 2 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setSelectedTables((prev) => {
                            const next = new Set(prev);
                            if (next.has(key)) next.delete(key);
                            else next.add(key);
                            return next;
                          })
                        }
                      />
                      <code style={{ fontSize: 13 }}>{t.name}</code>
                    </label>
                    {t.columns.map((c) => (
                      <div key={c.name} style={{ fontSize: 12, lineHeight: 1.9, display: "flex", justifyContent: "space-between", gap: 16 }}>
                        <span>
                          <code>{c.name}</code>
                          <span style={{ color: "var(--ink-3)" }}> {c.type}{c.pk ? " · 主键" : ""}{c.comment ? ` · ${c.comment}` : ""}</span>
                        </span>
                        <span style={{ color: "var(--ink-3)" }}>{columnTarget(activeSource.connection, t.name, c.name)}</span>
                      </div>
                    ))}
                    {/* 脱敏采样（最多 3 行，REST 已带过）：空表写「没有行」；连接 error / 没给 sample 不画这块 */}
                    {t.sample ? (
                      <div style={{ marginTop: 6, borderTop: "1px dashed var(--hairline)", paddingTop: 6, fontSize: 11, color: "var(--ink-3)", lineHeight: 1.8 }}>
                        {t.sample.length === 0
                          ? "没有行"
                          : t.sample.map((row, i) => (
                              <div key={i} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={JSON.stringify(row)}>
                                {Object.entries(row)
                                  .map(([k, v]) => `${k}: ${v == null ? "空" : String(v)}`)
                                  .join(" · ")}
                              </div>
                            ))}
                      </div>
                    ) : null}
                  </Bezel>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
