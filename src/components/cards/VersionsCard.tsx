// 版本历史卡：点某版把内容覆盖到当前画布（未发布）。列表自取数（挂载即拉 /api/versions），页面不代管。
"use client";

import { useEffect, useState } from "react";
import Bezel from "./Bezel";
import { apiGet } from "../workspaceClient";
import type { OntologyResp } from "../ontFrame";

export default function VersionsCard({
  ont,
  rollbacking,
  onRollback,
  onError,
  onClose,
}: {
  ont: OntologyResp | null;
  rollbacking: boolean;
  onRollback: (version: number) => void;
  onError: (e: unknown) => void;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<{ version: number; createdAt: string }[] | null>(null); // null = 读着呢
  useEffect(() => {
    let alive = true;
    apiGet<{ versions?: { version: number; createdAt: string }[] }>("/api/versions")
      .then((data) => { if (alive) setVersions(data.versions ?? []); })
      .catch((e) => { if (alive) onError(e); });
    return () => { alive = false; };
  }, [onError]);
  return (
    <div className="float-card float-tl dock-follow" style={{ width: 300 }}>
      <Bezel>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>版本历史</span>
          <button className="chip" aria-label="关闭" onClick={onClose}>✕</button>
        </div>
        {versions === null && <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>读着呢…</div>}
        {versions !== null && ont && !ont.version ? (
          // 从未发布（注册不产生已发布版本，首版由人发布）
          <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>还没有发布过——发布一次之后这里会列出历史版本</div>
        ) : (
          (versions ?? []).map((v) => (
            <div key={v.version} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, lineHeight: 2.2 }}>
              <span>
                <strong>v{v.version}</strong>　<span style={{ color: "var(--ink-3)" }}>{v.createdAt.slice(0, 16).replace("T", " ")}</span>
              </span>
              <button className="chip" disabled={rollbacking} onClick={() => onRollback(v.version)}>
                回到这版
              </button>
            </div>
          ))
        )}
      </Bezel>
    </div>
  );
}
