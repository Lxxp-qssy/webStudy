<script setup>
import PaneFrame from "./PaneFrame.vue";
defineProps({
  model: { type: Object, required: true },
  next: { type: Object, default: null },
  actions: { type: Array, default: () => [] },
  idle: { type: Object, default: () => ({ items: [] }) }
});
const emit = defineEmits(["action"]);
</script>

<template>
  <PaneFrame tag="03" title="现象层 · 为什么" cls="why">

    <div class="why-body">
      <Transition name="whyfade" mode="out-in">
        <div :key="model.seq" class="why-inner">

          <div v-if="model.mode === 'idle'" class="diff">
            <div class="diff-cmd">等待操作</div>
            <div class="diff-none">在命令层敲任何一条命令，这里都会解读它改动了哪张表的哪一行；敲错也会说明为什么被拒。</div>
          </div>

          <div v-else class="diff" :class="{ bad: model.mode === 'error', done: model.mode === 'done' }">
            <div class="diff-cmd">{{ model.cmd }}</div>
            <template v-if="model.mode === 'diff'">
              <div v-for="(r, i) in model.rows" :key="i" class="diff-row">
                <span class="diff-key">{{ r.k }}</span>
                <span class="diff-from">{{ r.from }}</span>
                <span class="diff-arrow">→</span>
                <span class="diff-to">{{ r.to }}</span>
              </div>
            </template>
            <div v-else-if="model.mode === 'error'" class="diff-none">设备拒绝了这条命令，表项没有任何变化。</div>
            <div v-else-if="model.mode === 'doc'" class="diff-none">只读命令，没有改动任何表项。中间面板显示的是当前状态。</div>
            <div v-else-if="model.mode === 'view'" class="diff-none">视图切换，不动任何表项。提示符已更新。</div>
            <div v-else-if="model.mode === 'nochange'" class="diff-none">命令被接受，但设备上没有表项发生变化。</div>
            <div v-else-if="model.mode === 'done'" class="diff-none">这一板块的目标配置已完成。</div>
          </div>

          <div v-if="model.items && model.items.length">
            <div class="why-title">{{ model.title || (model.mode === 'error' ? '为什么被拒绝' : '逐层判读') }}</div>
            <div class="trace">
              <div v-for="(it, i) in model.items" :key="i" class="trace-item" :class="it.cls">
                <div class="trace-h">{{ it.h }}</div>
                <div class="trace-p" v-html="it.p"></div>
              </div>
            </div>
          </div>

          <template v-if="model.mode === 'idle'">
            <div class="why-title">{{ idle.title || '判读顺序' }}</div>
            <div class="trace">
              <div v-for="(it, i) in idle.items" :key="i" class="trace-item" :class="it.cls">
                <div class="trace-h">{{ it.h }}</div>
                <div class="trace-p" v-html="it.p"></div>
              </div>
            </div>
          </template>

          <div v-if="model.verdict" class="note" :class="{ warn: model.verdict.bad }">{{ model.verdict.text }}</div>

          <div v-if="next && next.cmd" class="why-title">接下来</div>
          <div v-if="next && next.cmd" class="next">
            <code @click="$emit('fill', next.cmd)">{{ next.cmd }}</code>
            <span>{{ next.why }}</span>
          </div>
          <div v-else-if="next && next.why" class="next"><span>{{ next.why }}</span></div>
        </div>
      </Transition>
    </div>

    <div class="actions">
      <button v-for="a in actions" :key="a.id" class="act" @click="emit('action', a.id)">{{ a.label }}</button>
    </div>
  </PaneFrame>
</template>
