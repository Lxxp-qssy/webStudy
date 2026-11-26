<script setup>
/**
 * 面板骨架：标签 + 标题 + 右侧操作区 + 内容 + 底部。
 * 三个工作面板（命令 / 表项 / 现象）共用同一套边框、标题与滚动约定，
 * 各面板只负责自己的内容，不再重复 .pane / .pane-head 结构。
 */
defineProps({
  tag: { type: String, default: "" },
  title: { type: String, default: "" },
  cls: { type: String, default: "" }
});
</script>

<template>
  <section class="pane" :class="cls">
    <div class="pane-head">
      <span v-if="tag" class="tag">{{ tag }}</span>
      <h2>{{ title }}</h2>
      <slot name="head" />
    </div>

    <slot />

    <slot name="foot" />
  </section>
</template>
