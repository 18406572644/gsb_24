/**
 * 高亮层双通道刷新调度（trailing throttle，rAF 对齐）。
 *
 * 大文档下 highlightHtml 是对全文的 O(n) 重算，高频触发（尤其多人远程光标
 * 上报）会导致背景层卡顿。调度策略：
 * - 文本/批注变更（doc 通道）：立即刷新，保证本地编辑所见即所得；
 * - 远程光标（cursor 通道）：按帧合并、并受最小间隔约束，连发只产出末次状态；
 * - 任一通道刷新时都取最新快照，因此不会丢失最终结果（trailing 保证）。
 */

export interface ThrottleScheduler {
  /** 安排一次 doc 通道刷新（文本/批注/激活态变化） */
  scheduleDoc: () => void
  /** 安排一次 cursor 通道刷新（远程光标更新） */
  scheduleCursor: () => void
  /** 释放 rAF / 定时器 */
  dispose: () => void
}

export interface SchedulerClock {
  /** 默认 window.requestAnimationFrame，测试中可注入假时钟 */
  raf: (cb: () => void) => number
  caf: (id: number) => void
  setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void
  now: () => number
}

export function createRenderThrottle(
  render: () => void,
  cursorIntervalMs: number,
  clock: SchedulerClock,
): ThrottleScheduler {
  let rafId: number | null = null
  let trailingTimer: ReturnType<typeof setTimeout> | null = null
  let lastFlush = 0

  const run = () => {
    rafId = null
    if (trailingTimer !== null) {
      clock.clearTimeout(trailingTimer)
      trailingTimer = null
    }
    lastFlush = clock.now()
    render()
  }

  const scheduleFrame = () => {
    if (rafId !== null) return
    rafId = clock.raf(run)
  }

  return {
    scheduleDoc() {
      // 已有待执行帧会在执行时读取最新状态，直接复用
      scheduleFrame()
    },
    scheduleCursor() {
      if (rafId !== null) return // 已有待执行帧，最新光标会被顺带渲染
      const wait = cursorIntervalMs - (clock.now() - lastFlush)
      if (wait <= 0) {
        scheduleFrame()
      } else if (trailingTimer === null) {
        trailingTimer = clock.setTimeout(() => {
          trailingTimer = null
          scheduleFrame()
        }, wait)
      }
      // 连发期间 trailingTimer 复用，仅最后一次计时有效 → 中间更新被合并
    },
    dispose() {
      if (rafId !== null) clock.caf(rafId)
      if (trailingTimer !== null) clock.clearTimeout(trailingTimer)
      rafId = null
      trailingTimer = null
    },
  }
}
