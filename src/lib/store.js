/* 学习进度：localStorage 单一命名空间，首页与实验页共用 */

const KEY = "netlab.progress.v2";

export function readAll(){
  try{
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  }catch(e){
    return {};
  }
}

export function readLab(id){
  const all = readAll();
  const rec = all["lab" + id];
  return rec && typeof rec === "object"
    ? { done: rec.done || 0, total: rec.total || 0, ts: rec.ts || 0 }
    : { done: 0, total: 0, ts: 0 };
}

export function writeLab(id, done, total){
  try{
    const all = readAll();
    all["lab" + id] = { done, total, ts: Date.now() };
    localStorage.setItem(KEY, JSON.stringify(all));
  }catch(e){ /* 隐私模式下忽略 */ }
}

export function clearLab(id){
  try{
    const all = readAll();
    delete all["lab" + id];
    localStorage.setItem(KEY, JSON.stringify(all));
  }catch(e){ /* 隐私模式下忽略 */ }
}

export function overall(list){
  let done = 0, total = 0, touched = 0;
  list.forEach(function(it){
    const r = readLab(it.id);
    if(r.done > 0) touched++;
    done += Math.min(r.done, it.steps || 0);
    total += it.steps || 0;
  });
  return { done, total, touched, pct: total ? Math.round(done / total * 100) : 0 };
}
