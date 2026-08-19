import { execSync } from "node:child_process";

// 把当前 git 短 hash 打进客户端 bundle：左上角显示，验收时一眼分辨页面是不是旧代码
let gitSha = "unknown";
try {
  gitSha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
} catch {
  // 非 git 环境不强求
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  env: { NEXT_PUBLIC_GIT_SHA: gitSha },
};

export default nextConfig;
