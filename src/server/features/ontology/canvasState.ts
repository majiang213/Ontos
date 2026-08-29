// 界面状态三键的跟随纪律 —— 摆位 / 弯折 / 钉点：不算本体（不校验、不算 dirty、不算内容改动），但要落库（bump rev）、
// 要随关系改名搬迁、要在事务收尾清死键。三键的写入一律走这里的原语，不许在别处直接改 state.layout / edgeBends / edgePins。

import type { BorderPin } from "../../schema/ops";
import type { DraftState } from "./canvasPack";

/** 两端钉点（建线/改接的可选随车键）。 */
export type PinEnds = { source?: BorderPin; target?: BorderPin };

/** pins 键里实际给了的端（undefined 端不进记录）：至少一端返回记录，都没给返回 null。 */
export function definedPinEnds(pins: PinEnds | undefined): PinEnds | null {
  const out = Object.fromEntries(Object.entries(pins ?? {}).filter(([, v]) => v !== undefined));
  return Object.keys(out).length ? out : null;
}

/** 摆位并入（save_layout）：只进内存；落库在 editDraft 的界面状态分流。 */
export function setLayout(state: DraftState, positions: DraftState["layout"]): void {
  state.layout = { ...state.layout, ...positions };
}

/** 弯折写入（save_edge_bend）：bend 为 null = 拉直（删键）。 */
export function setEdgeBend(state: DraftState, name: string, bend: { dx: number; dy: number } | null): void {
  if (bend) state.edgeBends[name] = bend;
  else delete state.edgeBends[name];
}

/** 钉点整记（create_link 随车）：建线一把落库，不再有 save_edge_pin 接力。 */
export function setEdgePins(state: DraftState, name: string, pins: PinEnds): void {
  state.edgePins[name] = pins;
}

/** 钉点按端合并（update_link 随车）：只给的端覆盖，没给的端不动。 */
export function mergeEdgePins(state: DraftState, name: string, pins: PinEnds): void {
  state.edgePins[name] = { ...state.edgePins[name], ...pins };
}

/** 类改名：摆位以类名为键——不跟就成孤儿。 */
export function renameLayoutKey(state: DraftState, oldName: string, newName: string): void {
  if (state.layout[oldName]) {
    state.layout[newName] = state.layout[oldName];
    delete state.layout[oldName];
  }
}

/** 关系改名：钉点与弯折以关系名为键——不跟就成孤儿，改名即丢。 */
export function renameEdgeState(state: DraftState, oldName: string, newName: string): void {
  if (state.edgePins[oldName]) {
    state.edgePins[newName] = state.edgePins[oldName];
    delete state.edgePins[oldName];
  }
  if (state.edgeBends[oldName]) {
    state.edgeBends[newName] = state.edgeBends[oldName];
    delete state.edgeBends[oldName];
  }
}

/** 清死键：对象没了清摆位、关系没了清弯折和钉点。只在事务收尾（校验已过）调——回退路径不调，不丢。 */
export function gcDeadKeys(state: DraftState): void {
  for (const name of Object.keys(state.layout)) if (!state.draft.object_types[name]) delete state.layout[name];
  for (const name of Object.keys(state.edgeBends)) if (!state.draft.link_types[name]) delete state.edgeBends[name];
  for (const name of Object.keys(state.edgePins)) if (!state.draft.link_types[name]) delete state.edgePins[name];
}
