<template>
  <svg :viewBox="`0 0 ${size} ${size}`" :width="size" :height="size" class="block">
    <circle :cx="size / 2" :cy="size / 2" :r="radius" fill="none" stroke="var(--color-neutral)" :stroke-width="stroke" />
    <circle :cx="size / 2" :cy="size / 2" :r="radius" fill="none" :stroke="color" :stroke-width="stroke"
      :stroke-dasharray="circumference" :stroke-dashoffset="offset" class="gauge-ring"
      :transform="`rotate(-90 ${size / 2} ${size / 2})`" 
      style="transition: stroke-dashoffset 0.5s ease" />
    <text x="50%" y="50%" dominant-baseline="central" text-anchor="middle"
      fill="var(--color-base-content)" :font-size="`${size * 0.26}px`" font-weight="700">{{ percent }}%</text>
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps({
  percent: { type: Number, required: true },
  size: { type: Number, default: 48 }, // matched original stats.ts size (48)
  stroke: { type: Number, default: 4 }
});

const radius = computed(() => (props.size - props.stroke) / 2);
const circumference = computed(() => 2 * Math.PI * radius.value);
const offset = computed(() => circumference.value * (1 - props.percent / 100));

const color = computed(() => {
    if (props.percent >= 80) return 'var(--color-error)';
    if (props.percent >= 50) return 'var(--color-warning)';
    return 'var(--color-primary)';
});
</script>
