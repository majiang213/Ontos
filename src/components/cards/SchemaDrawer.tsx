// 表结构抽屉：只看列定义（REST 会带回 3 行脱敏采样，本抽屉不画）；勾选表 → 生成对象直接上画布并收起。表永远是原料，不上画布。
"use client";

import { useState } from "react";
import Bezel from "./Bezel";

interface TableCol {
  name: string;
  type: string;
  pk: boolean;
  comment?: string;
}

export default function SchemaDrawer({
  schema,
  columnTarget,
  onGenerate,
}: {
  schema: { sources: { connection: string; error?: string; tables: { name: string; columns: TableCol[]; sample?: Record<string, unknown>[] }[] }[] } | null;
  columnTarget: (connection: string, table: string, column: string) => string;
  onGenerate: (tables: { connection: string; table: string }[]) => void;
}) {
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const generate = () => {
    const tables = [...selectedTables].map((key) => {
      const dot = key.indexOf("."); // 只切第一个点：连接名/表名里再有点不炸
      return { connection: key.slice(0, dot), table: key.slice(dot + 1) };
    });
    setSelectedTables(new Set());
    onGenerate(tables);
  };
  return (
    <div className="drawer">
      {selectedTables.size > 0 && (
        <div style={{ position: "sticky", top: 0, zIndex: 5, paddingBottom: 10, background: "var(--bg-deep)" }}>
          <button className="btn-cta" style={{ fontSize: 13, padding: "6px 8px 6px 16px" }} onClick={generate}>
            生成对象（{selectedTables.size} 张表）
          </button>
          <button className="btn" style={{ marginLeft: 8 }} onClick={() => setSelectedTables(new Set())}>清空选择</button>
        </div>
      )}
      {schema?.sources.map((s) => (
        <div key={s.connection} style={{ marginBottom: 20 }}>
          <span className="eyebrow">{s.connection}</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 10 }}>
            {s.tables.map((t) => {
              const key = `${s.connection}.${t.name}`;
              const checked = selectedTables.has(key);
              return (
                <Bezel key={t.name} pad={12} style={{ minWidth: 260, outline: checked ? "2px solid var(--accent)" : "none" }}>
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
                    <div key={c.name} style={{ fontSize: 12, lineHeight: 1.9, display: "flex", justifyContent: "space-between", gap: 14 }}>
                      <span>
                        <code>{c.name}</code>
                        <span style={{ color: "var(--ink-3)" }}> {c.type}{c.pk ? " · 主键" : ""}{c.comment ? ` · ${c.comment}` : ""}</span>
                      </span>
                      <span style={{ color: "var(--ink-3)" }}>{columnTarget(s.connection, t.name, c.name)}</span>
                    </div>
                  ))}
                </Bezel>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
