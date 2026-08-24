// 一次连线拖拽的会话 —— 开始（beginSession）→ 跟针（trackSession）→ 落成（fireSession）→
// 松手补命中（dropSession）→ 关（endSession）。任何时刻至多一个会话（单指针）；
// 预览线每帧读 currentSession()。会话状态原散四处（connectTrack 单例 / ringConnect 桥 / Flow ref×3 / 边 data 回调），收在这里。
// XYHandle 透传参数（xyDragArgs）也在这：四边连接条与改接捏点共用一份样板。

import { XYHandle } from "@xyflow/system";
import type { useStoreApi } from "@xyflow/react";
import type { Pt } from "./geometry";

export interface ConnectSession {
  kind: "new" | "reconnect"; // 新建连线 / 改接已有线（预览箭头方向与补命中的 commit 不同）
  fromNode: string; // 起拖节点（改接 = 不动那端的节点）：补命中的自连 veto
  start: Pt; // 抓取点（flow 坐标，决定源端钉点）
  last: Pt; // 最近指针位置（决定落点端钉点）
  fromHandleType: "source" | "target" | null; // 起拖把手类型（新建落成换向用；顶点拖出 xyflow 给反向，要换回）
  fired: boolean; // 已落成（松手补命中的闸：落成了不再补）
  onDrop?: (hitNodeId: string) => void; // 补命中落成时干什么（新建 = 补连线；改接 = 补改接，各带各的）
}

let current: ConnectSession | null = null;

export function beginSession(s: Omit<ConnectSession, "fired">): void {
  current = { ...s, fired: false };
}

export function currentSession(): ConnectSession | null {
  return current;
}

/** 跟针：只在会话进行中取数（监听器的无条件转发都安全）。 */
export function trackSession(p: Pt): void {
  if (current) current.last = p;
}

export function fireSession(): void {
  if (current) current.fired = true;
}

export function endSession(): void {
  current = null;
}

/** 松手位置命中哪个节点（DOM 查询一处；测试经参数注入桩，不碰真 DOM）。 */
function defaultFindNode(clientX: number, clientY: number): string | null {
  return document.elementFromPoint(clientX, clientY)?.closest(".react-flow__node")?.getAttribute("data-id") ?? null;
}

/** 松手补命中（纪律单源）：XYHandle 松手只吃最后一次采样——快速甩过去时采样还在半空，松手点已在节点上却判落空。
 *  三条纪律：①已落成不补；②命中须是别个节点（非 fromNode）；③补前 last 更新为松手处（落点端钉点按松手算）。
 *  命中后干什么由会话的 onDrop 定（新建/改接各带各的 commit）。 */
export function dropSession(
  clientX: number,
  clientY: number,
  toFlow: (p: Pt) => Pt,
  findNode: (x: number, y: number) => string | null = defaultFindNode
): void {
  const s = current;
  if (!s || s.fired) return;
  const hit = findNode(clientX, clientY);
  if (!hit || hit === s.fromNode) return;
  s.last = toFlow({ x: clientX, y: clientY });
  s.onDrop?.(hit);
}

/* ---------- XYHandle 透传参数（原 connectTrack.xyDragArgs） ---------- */

type StoreApi = ReturnType<typeof useStoreApi>;
type XyDragArgs = Parameters<typeof XYHandle.onPointerDown>[1];

/** XYHandle.onPointerDown 的透传参数一处产：从 store 逐字段抄的样板都在这里，四边连接条（OntologyCanvas）
 *  与改接捏点（FloatingEdge）共用——xyflow 加/改字段只动这里。getTransform 等闭包每次现读 store，不缓存旧状态。 */
export function xyDragArgs(
  store: StoreApi,
  base: Pick<XyDragArgs, "handleDomNode" | "isTarget" | "nodeId" | "onConnect" | "onConnectEnd"> & Partial<XyDragArgs>
): XyDragArgs {
  const s = store.getState();
  return {
    autoPanOnConnect: s.autoPanOnConnect,
    connectionMode: s.connectionMode,
    connectionRadius: s.connectionRadius,
    domNode: s.domNode,
    nodeLookup: s.nodeLookup,
    lib: s.lib,
    handleId: null,
    flowId: s.rfId,
    panBy: s.panBy,
    cancelConnection: s.cancelConnection,
    onConnectStart: s.onConnectStart,
    updateConnection: s.updateConnection,
    autoPanSpeed: s.autoPanSpeed,
    dragThreshold: s.connectionDragThreshold,
    isValidConnection: (...args) => store.getState().isValidConnection?.(...args) ?? true,
    getTransform: () => store.getState().transform,
    getFromHandle: () => store.getState().connection.fromHandle,
    ...base,
  };
}
