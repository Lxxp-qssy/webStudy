import { build } from "vite";
import fs from "node:fs";
import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * 逐页构建。
 * 多个入口一起构建时，Rollup 会把 Vue 运行时等公共部分拆成独立 chunk，
 * 而独立 chunk 在 file:// 下会被 CORS 拦掉。所以这里一页一次构建，
 * 保证每个产物都是「一个文件、零外部引用、双击可开」。
 */
const PAGES = [
  { name: "index", source: "index.html" },
  { name: "lab-01", source: "lab-01.html" },
  { name: "lab-03", source: "lab-03.html" },
  { name: "lab-02", source: "lab-02.html" },
  { name: "lab-04", source: "lab-04.html" },
  { name: "lab-05", source: "lab-05.html" },
  { name: "lab-06", source: "lab-06.html" },
  { name: "lab-07", source: "lab-07.html" },
  { name: "lab-08", source: "lab-08.html" },
  { name: "lab-09", source: "lab-09.html" },
  { name: "lab-10", source: "lab-10.html" },
  { name: "lab-11", source: "lab-11.html" },
  { name: "lab-12", source: "lab-12.html" }
];

const outDir = path.resolve("dist");
const rootDir = path.resolve("entries");
fs.rmSync(outDir, { recursive: true, force: true });

for (const page of PAGES){
  await build({
    root: rootDir,
    configFile: false,
    base: "./",
    plugins: [
      vue(),
      viteSingleFile({ removeViteModuleLoader: true, useRecommendedBuildConfig: true })
    ],
    build: {
      outDir,
      emptyOutDir: false,
      write: true,
      assetsInlineLimit: 1024 * 1024 * 8,
      cssCodeSplit: false,
      target: "es2019",
      rollupOptions: { input: { [page.name]: path.resolve(rootDir, page.source) } }
    }
  });
  console.log("✓ " + page.name + ".html");
}

/* 产物自检：不允许出现任何外部脚本 / 样式引用 */
let bad = 0;
for (const page of PAGES){
  const file = path.join(outDir, page.name + ".html");
  const html = fs.readFileSync(file, "utf8");
  const ext = html.match(/<(script|link)[^>]+(src|href)="(?!data:)([^"]+)"/g) || [];
  const size = (fs.statSync(file).size / 1024).toFixed(1);
  console.log("  " + page.name + ".html  " + size + " kB  外部引用 " + ext.length);
  if(ext.length){ console.log("  ✗ " + ext.join("\n    ")); bad++; }
}
if(bad) process.exitCode = 1;
else console.log("✓ 全部自包含，可断网双击打开");
