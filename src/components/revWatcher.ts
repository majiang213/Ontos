// 画布监视器 —— 每 2 秒轮询工作副本（隐页暂停），把 rev / ETag / 304 / 失败一次的同步纪律收进一个 module。
// interface 就是三个回调：onFrame（有实质变化）、onFormBlocked（表单开着：记下 rev 并提示）、onFailOnce（首次失败提醒）。
// 本页写入经 busy() 豁免，不当外部改动；本页自己的刷新经 noteApplied 同步 rev/etag。
// 自有 fetch（cache: no-store + If-None-Match）：apiGet 对非 2xx 抛错且拿不到 304，不能复用。

import { useEffect, useMemo, useRef } from "react";
import { etagOf } from "../server/etag";
import { getWs } from "./wsClient";

export interface RevFrame {
  rev: number;
  [k: string]: unknown;
}

export interface RevWatcher {
  /** 本页写入/首轮刷新后同步 rev 与 ETag（与服务端 etagOf 同格式）。 */
  noteApplied: (rev: number) => void;
  /** 打开表单那一刻的 rev：保存前比对，不一样要先问。 */
  currentRev: () => number | null;
}

export function useRevWatcher(opts: {
  busy: () => boolean;
  formBusy: () => boolean;
  onFrame: (data: RevFrame) => void;
  onFormBlocked: () => void;
  onFailOnce: () => void;
}): RevWatcher {
  const etagRef = useRef<string | null>(null);
  const lastRev = useRef<number | null>(null);
  const pollFailed = useRef(false);
  // 回调进 ref：interval 只注册一次，回调身份随渲染更新，不 churn
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  useEffect(() => {
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      const { busy, formBusy, onFrame, onFormBlocked, onFailOnce } = optsRef.current;
      try {
        const r = await fetch(`/api/ontology?ws=${encodeURIComponent(getWs())}`, {
          cache: "no-store",
          headers: etagRef.current ? { "If-None-Match": etagRef.current } : {},
        });
        if (r.status === 304) {
          pollFailed.current = false;
          return; // 无变化
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as RevFrame;
        pollFailed.current = false;
        if (busy()) return; // 本页正在写：它自己会 refresh，不当外部改动
        if (lastRev.current !== null && data.rev === lastRev.current) return; // rev 没变（兜底；正常走 304）
        lastRev.current = data.rev;
        etagRef.current = r.headers.get("etag") ?? etagRef.current;
        if (formBusy()) {
          onFormBlocked(); // 表单开着：不冲掉未保存的内容，记下 rev 提示
          return;
        }
        onFrame(data);
      } catch {
        if (!pollFailed.current) {
          pollFailed.current = true; // 失败一次就提醒，但不每 2 秒弹
          onFailOnce();
        }
      }
    };
    const timer = setInterval(tick, 2000);
    return () => clearInterval(timer);
  }, []);

  return useMemo(
    () => ({
      noteApplied: (rev: number) => {
        lastRev.current = rev;
        etagRef.current = etagOf(getWs(), rev);
      },
      currentRev: () => lastRev.current,
    }),
    []
  );
}
