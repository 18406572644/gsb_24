/**
 * 编辑器性能保护装配：正文字符统计、大文档阈值判定、高亮层双通道节流刷新。
 *
 * 从 EditorView.vue 抽出，便于以注入时钟的方式在无 DOM 环境下验收
 * （空文档 / 长文本粘贴 / 多人远程光标高频更新）。
 */
import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue'
import { buildHighlightHtml, type HighlightUser } from '@/highlight'
import { createRenderThrottle, type SchedulerClock } from '@/renderThrottle'
import { isLongDoc, REMOTE_CURSOR_REFRESH_MS } from '@/perf'
import type { Annotation } from '../../shared/protocol'

interface PerfSession {
  clientId: string
  cursors: Record<string, { start: number; end: number }>
  users: HighlightUser[]
}

interface PerfDoc {
  text: string
  annotations: Annotation[]
  activeAnnId: string | null
}

const browserClock: SchedulerClock = {
  raf: (cb) =>
    typeof requestAnimationFrame !== 'undefined'
      ? requestAnimationFrame(cb)
      : (globalThis.setTimeout(cb, 16) as unknown as number),
  caf: (id) =>
    typeof cancelAnimationFrame !== 'undefined'
      ? cancelAnimationFrame(id)
      : globalThis.clearTimeout(id),
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  now: () =>
    typeof performance !== 'undefined' ? performance.now() : Date.now(),
}

export interface EditorPerf {
  /** backdrop 层 innerHTML（节流刷新） */
  highlightHtml: Ref<string>
  charCount: ComputedRef<number>
  /** 正文长度是否达到性能提示阈值 */
  longDoc: ComputedRef<boolean>
}

export interface UseEditorPerfOptions {
  /** 注入调度时钟（测试用），默认浏览器 rAF/performance */
  clock?: SchedulerClock
  /** 正文长度从阈值下方跨越到上方时触发一次（回落再超过会再次触发） */
  onLongDocEnter?: () => void
}

export function useEditorPerf(
  session: PerfSession,
  doc: PerfDoc,
  options: UseEditorPerfOptions = {},
): EditorPerf {
  const clock = options.clock ?? browserClock
  const highlightHtml = ref('')
  const charCount = computed(() => doc.text.length)
  const longDoc = computed(() => isLongDoc(charCount.value))

  const renderHighlight = () => {
    highlightHtml.value = buildHighlightHtml({
      text: doc.text,
      annotations: doc.annotations,
      activeAnnId: doc.activeAnnId,
      me: session.clientId,
      cursors: session.cursors,
      users: session.users,
    })
  }

  const renderThrottle = createRenderThrottle(renderHighlight, REMOTE_CURSOR_REFRESH_MS, clock)

  // 文本 / 批注变化：本地编辑所见即所得，走立即通道（下一帧统一渲染）
  // flush:'sync' 使节流计时在状态变更当下就确定，时序可预测，也避免一帧内多次触发
  watch(
    () => [doc.text, doc.annotations, doc.activeAnnId],
    () => renderThrottle.scheduleDoc(),
    { deep: true, immediate: true, flush: 'sync' },
  )

  // 远程光标 / 在线用户：多人同时输入时高频上报，走节流通道，连发只渲染末次位置
  watch(
    () => [session.cursors, session.users],
    () => renderThrottle.scheduleCursor(),
    { deep: true, flush: 'sync' },
  )

  // 阈值跨越提示（一次性长文本粘贴即从 false → true）
  if (options.onLongDocEnter) {
    watch(
      longDoc,
      (v, prev) => {
        if (v && !prev) options.onLongDocEnter!()
      },
      { flush: 'sync' },
    )
  }

  onScopeDispose(() => renderThrottle.dispose())

  return { highlightHtml, charCount, longDoc }
}
