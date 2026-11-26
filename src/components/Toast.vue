<script setup>
defineProps({ toast: { type: Object, default: null } });
</script>

<template>
  <Transition name="toast">
    <div v-if="toast" class="toast" :key="toast.id">
      <div class="toast-ring"></div>
      <div class="toast-body">
        <div class="toast-t"><span class="toast-tick">✓</span>{{ toast.title }}</div>
        <div v-if="toast.text" class="toast-s">{{ toast.text }}</div>
      </div>
    </div>
  </Transition>
</template>
