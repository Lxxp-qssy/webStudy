import { createApp } from "vue";
import VueParticles from "@tsparticles/vue3";
import { loadSlim } from "@tsparticles/slim";
import "../styles/index.css";

/**
 * 全站统一装配线：
 *   - 引入全局样式（app.css + motion.css）
 *   - 安装 tsParticles 插件（slim 引擎：粒子 + 连线，动态背景用）
 * 13 个入口全部走这里，插件与样式只装载一次，入口只负责「哪个页面 + 哪份定义」。
 */
export function mountApp(root, props) {
  const app = createApp(root, props);
  app.use(VueParticles, {
    init: async (engine) => {
      await loadSlim(engine);
    }
  });
  app.mount("#app");
}
