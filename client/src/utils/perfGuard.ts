/**
 * 大文档性能保护（纯前端，不涉及 OT 协议）：
 * 正文超过阈值时，协作高亮（远程光标/选区/批注标记）与字符统计的刷新降频，
 * 并向用户提示可能的性能影响。
 */

/** 正文字符数超过该阈值时提示性能影响并对高频刷新降频 */
export const PERF_HINT_THRESHOLD = 50_000

/** 协作高亮（远程光标/批注标记等指示）刷新节流间隔 */
export const HIGHLIGHT_THROTTLE_MS = 200

/** 顶部字符统计显示的节流间隔 */
export const COUNT_THROTTLE_MS = 300

/** 是否应提示性能影响（超过预设阈值） */
export function shouldWarnPerf(charCount: number): boolean {
  return charCount > PERF_HINT_THRESHOLD
}

/** 千分位格式化字符数；不依赖运行时 ICU/locale，保证各环境显示一致 */
export function formatCharCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export interface ThrottledFn {
  (): void
  /** 取消挂起的尾随执行（组件卸载时调用） */
  cancel(): void
}

/**
 * 通用节流（首次立即 + 窗口内合并为一次尾随执行）。
 * 用于远程光标、批注标记等高频指示刷新：突发调用合并执行，避免大文档下
 * 高亮层每次消息都全量重算导致渲染卡顿。fn 在执行时才读取最新状态，
 * 因此尾随执行天然携带突发期间的最新数据。
 */
export function createThrottle(fn: () => void, intervalMs: number): ThrottledFn {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const run = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    last = Date.now()
    fn()
  }

  const throttled = () => {
    const elapsed = Date.now() - last
    if (elapsed >= intervalMs) {
      run()
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null
        run()
      }, intervalMs - elapsed)
    }
  }
  throttled.cancel = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  return throttled
}
