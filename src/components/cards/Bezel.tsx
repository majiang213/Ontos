// Double-Bezel 壳（唯一写处）：外壳托盘（bezel）+ 内核（bezel-core）。
// 全站的卡面 chrome 都走这里，不再手抄两层 div。pad 给档位数或 CSS 串；coreStyle 补内核的额外形（滚动/布局）。
import type { CSSProperties, ReactNode } from "react";

export default function Bezel({
  pad = 14,
  className,
  style,
  coreStyle,
  children,
}: {
  pad?: number | string;
  className?: string;
  style?: CSSProperties;
  coreStyle?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div className={`bezel${className ? ` ${className}` : ""}`} style={style}>
      <div className="bezel-core" style={{ padding: pad, ...coreStyle }}>
        {children}
      </div>
    </div>
  );
}
