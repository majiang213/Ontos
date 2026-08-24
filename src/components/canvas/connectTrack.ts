// 一次连线拖拽的跟踪状态（flow 坐标）。模块级：拖拽起点在 onConnectStart 里埋（节点把手与四边连接条同走这一路），
// 预览线组件 FloatingConnectionLine 每帧读——钉点预览要与松手后的边一致。
import { XYHandle } from "@xyflow/system";
import type { useStoreApi } from "@xyflow/react";

export const connectTrack = {
  active: false,
  start: null as { x: number; y: number } | null, // 抓取点（决定源端钉点）
  last: null as { x: number; y: number } | null, // 最近指针位置（决定落点端钉点）
};

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
