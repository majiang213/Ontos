// 自适应高度的多行输入：内容多高框就多高（不受 rows 截断、不出滚动条），minRows 保底空态高度。
// 受控逻辑仍归调用方（defaultValue + onBlur），本组件只管长个；长个时机 = 挂载与每次渲染（按当前内容重算）。

import { useEffect, useRef } from "react";
import type { TextareaHTMLAttributes } from "react";

export default function AutoTextarea({ minRows = 1, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(() => {
    if (ref.current) grow(ref.current);
  });
  return (
    <textarea
      {...rest}
      ref={ref}
      rows={minRows}
      style={{ width: "100%", resize: "none", overflow: "hidden", ...(rest.style as object) }}
      onInput={(e) => grow(e.currentTarget)}
    />
  );
}
