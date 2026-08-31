// 底中判定卡的外壳（唯一写处）：根容器管定位（float-card float-bc decide），Bezel 管卡面，
// decide-head 管标题与关闭，decide-body 管滚动区。卡面与滚动契约曾因手抄两层丢失（2026-09-02 教训），
// 抽到这里之后留痕卡与待定卡都只写内容，不再各抄一遍结构。

import type { ReactNode } from "react";
import Bezel from "./Bezel";

export default function DecideCard({ title, drawerOpen, onClose, children }: {
  title: string;
  drawerOpen?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className={`float-card float-bc decide${drawerOpen ? " is-lifted" : ""}`}>
      <Bezel pad={0}>
        <div className="decide-head">
          <span className="decide-title">{title}</span>
          <span className="decide-head-actions">
            <button className="chip" aria-label="关闭" onClick={onClose}>✕</button>
          </span>
        </div>
        <div className="decide-body">{children}</div>
      </Bezel>
    </div>
  );
}
