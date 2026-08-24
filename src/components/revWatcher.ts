// 画布监视器 —— 每 2 秒轮询工作副本（隐页暂停），把 rev / ETag / 304 / 失败一次的同步纪律收进一个 module。
// pollOnce 是一轮轮询的纯函数核心（注入 fetch 即可直测）；React hook 只负责定时器与页面可见性。
// interface 就是三个回调：onFrame（有实质变化）、onFormBlocked（表单开着：记下 rev 并提示）、onFailOnce（首次失败提醒）。
// 本页写入经 busy() 豁免，不当外部改动；本页自己的刷新经 noteApplied 同步 rev/etag。
// 自有 fetch（cache: no-store + If-None-Match）：apiGet 对非 2xx 抛错且拿不到 304，不能复用。

import { useEffect, useMemo, useRef } from "react";
import { etagOf } from "../server/etag";
import { getWs } from "./wsClient";
import type { OntologyResp } from "./ontFrame";

export type RevFrame = OntologyResp;

export interface RevWatcher {
  /** 本页写入/首轮刷新后同步 rev 与 ETag（与服务端 etagOf 同格式）。 */
  noteApplied: (rev: number) => void;
  /** 打开表单那一刻的 rev：保存前比对，不一样要先问。 */
  currentRev: () => number | null;
}

/* ---------- pollOnce：一轮轮询的纯函数核心 ---------- */

export interface WatcherState {
  lastRev: number | null;
  etag: string | null;
  failedOnce: boolean;
}

export type PollResult = { kind: "idle" } | { kind: "frame"; data: RevFrame } | { kind: "formBlocked" } | { kind: "failOnce" };

/** 一轮轮询：304 不动；rev 没变不动；本页正在写不动（但失败标记清零）；表单开着记 rev 后报 formBlocked；有实质变化报 frame。
 *  失败第一次报 failOnce，连着失败静默，恢复后失败标记清零。 */
export async function pollOnce(
  ws: string,
  state: WatcherState,
  deps: { busy: () => boolean; formBusy: () => boolean },
  fetchImpl: typeof fetch
): Promise<{ state: WatcherState; result: PollResult }> {
  try {
    const r = await fetchImpl(`/api/ontology?ws=${encodeURIComponent(ws)}`, {
      cache: "no-store",
      headers: state.etag ? { "If-None-Match": state.etag } : {},
    });
    if (r.status === 304) return { state: { ...state, failedOnce: false }, result: { kind: "idle" } }; // 无变化
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = (await r.json()) as RevFrame;
    if (deps.busy()) return { state: { ...state, failedOnce: false }, result: { kind: "idle" } }; // 本页正在写：它自己会 refresh，不当外部改动
    if (state.lastRev !== null && data.rev === state.lastRev) {
      return { state: { ...state, failedOnce: false }, result: { kind: "idle" } }; // rev 没变（兜底；正常走 304）
    }
    const next: WatcherState = { lastRev: data.rev, etag: r.headers.get("etag") ?? state.etag, failedOnce: false };
    if (deps.formBusy()) return { state: next, result: { kind: "formBlocked" } }; // 表单开着：不冲掉未保存的内容，记下 rev 提示
    return { state: next, result: { kind: "frame", data } };
  } catch {
    if (state.failedOnce) return { state, result: { kind: "idle" } }; // 只提醒一次
    return { state: { ...state, failedOnce: true }, result: { kind: "failOnce" } };
  }
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
      const { state, result } = await pollOnce(
        getWs(),
        { lastRev: lastRev.current, etag: etagRef.current, failedOnce: pollFailed.current },
        { busy, formBusy },
        fetch
      );
      lastRev.current = state.lastRev;
      etagRef.current = state.etag;
      pollFailed.current = state.failedOnce;
      if (result.kind === "frame") onFrame(result.data);
      else if (result.kind === "formBlocked") onFormBlocked();
      else if (result.kind === "failOnce") onFailOnce();
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
