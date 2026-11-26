/* 通用工具：无依赖、纯函数 */

export const NS = "http://www.w3.org/2000/svg";

export function esc(t){
  return String(t == null ? "" : t)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function pad(s, n){
  s = String(s);
  while(s.length < n) s += " ";
  return s;
}

export function padL(s, n){
  s = String(s);
  while(s.length < n) s = " " + s;
  return s;
}

export function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }

export function normalize(line){
  return String(line == null ? "" : line).trim().replace(/\s+/g, " ");
}

/** 把 /a/g 之类的正则转成无状态版本，避免 test/exec 共享 lastIndex */
export function stateless(re){
  return new RegExp(re.source, re.flags.replace(/g/g, ""));
}

export function uid(prefix){
  uid.n = (uid.n || 0) + 1;
  return (prefix || "u") + uid.n;
}

/* 时间线缓动 */
export const ease = {
  outCubic: t => 1 - Math.pow(1 - t, 3),
  inOutCubic: t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
};

export function fmtTime(sec){
  const s = Math.max(0, sec);
  return s.toFixed(2) + "s";
}

/** 数字滚动用：把 0..1 的进度映射成带缓动的插值 */
export function lerp(a, b, t){ return a + (b - a) * t; }
