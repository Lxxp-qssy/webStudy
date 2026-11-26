import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * 构建目标：每个页面产出一个自包含的 HTML（JS/CSS 全部内联）。
 * dist/ 下的文件可以断网、双击直接打开，不依赖任何外部请求。
 */
export default defineConfig({
  root: "entries",
  base: "./",
  plugins: [
    vue(),
    viteSingleFile({ removeViteModuleLoader: true, useRecommendedBuildConfig: true })
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 1024 * 1024 * 8,
    cssCodeSplit: false,
    target: "es2019",
    rollupOptions: {
      input: {
        index: "index.html",
        "lab-01": "lab-01.html",
        "lab-03": "lab-03.html"
      }
    }
  }
});
