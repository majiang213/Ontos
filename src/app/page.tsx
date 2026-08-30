// Ontos —— 入口页（服务端渲染）。首屏空间由「上次打开的工作空间」cookie 决定：
// SSR 直接渲染它，客户端只做一次存在性校验（空间已删则回 default），不闪不切。
// 画布本体在 components/Home.tsx（客户端组件）。
import { cookies } from "next/headers";
import Home from "@/components/Home";

export default async function Page() {
  let initial = "default";
  try {
    const raw = (await cookies()).get("ontos.lastWorkspace")?.value;
    if (raw) initial = decodeURIComponent(raw);
  } catch {
    // cookie 读不出（隐私模式等）：回 default
  }
  return <Home initialWorkspace={initial} />;
}
