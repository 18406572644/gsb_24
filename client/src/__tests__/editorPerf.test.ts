import { describe, test, expect } from 'vitest'
import { effectScope, nextTick, reactive, watch } from 'vue'
import { useEditorPerf } from '@/useEditorPerf'
import { LONG_DOC_WARN_CHARS, REMOTE_CURSOR_REFRESH_MS } from '@/perf'
import type { SchedulerClock } from '@/renderThrottle'

/* 假时钟：手动推进 setTimeout / rAF，验证节流时序 */
function fakeClock(start = 0) {
  let t = start
  let rafSeq = 1
  let timerSeq = 1
  const rafs = new Map<number, () => void>()
  const timers = new Map<number, { fire: number; fn: () => void }>()
  const clock: SchedulerClock = {
    now: () => t,
    raf: (cb) => {
      const id = rafSeq++
      rafs.set(id, cb)
      return id
    },
    caf: (id) => rafs.delete(id),
    setTimeout: (cb, ms) => {
      const id = timerSeq++
      timers.set(id, { fire: t + ms, fn: cb })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: (id) => timers.delete(id as unknown as number),
  }
  return {
    clock,
    advance(ms: number) {
      t += ms
      for (const [id, e] of [...timers]) {
        if (e.fire <= t) {
          timers.delete(id)
          e.fn()
        }
      }
    },
    flushFrame() {
      const cbs = [...rafs.values()]
      rafs.clear()
      for (const cb of cbs) cb()
    },
    pendingTimers: () => timers.size,
    pendingFrames: () => rafs.size,
  }
}

function setup() {
  const doc = reactive({ text: '', annotations: [] as any[], activeAnnId: null as string | null })
  const session = reactive({
    clientId: 'me',
    cursors: {} as Record<string, { start: number; end: number }>,
    users: [
      { clientId: 'u1', name: 'Alice', color: '#ff0000', role: 'editor' },
      { clientId: 'u2', name: 'Bob', color: '#00ff00', role: 'editor' },
    ],
  })
  return { doc, session }
}

const ZWSP = '\u200b'

/** 执行待渲染帧并等待 Vue 的 pre-watcher 队列（渲染计数）落账 */
async function renderFrame(fc: ReturnType<typeof fakeClock>) {
  fc.flushFrame()
  await nextTick()
}

describe('正文字符统计与性能提示', () => {
  test('空文档：字数为 0、不提示、高亮层只有零宽占位', async () => {
    const fc = fakeClock()
    const { doc, session } = setup()
    let alerts = 0

    const scope = effectScope()
    const perf = scope.run(() =>
      useEditorPerf(session as any, doc as any, { clock: fc.clock, onLongDocEnter: () => alerts++ }),
    )!

    await renderFrame(fc) // 初始渲染
    expect(perf.charCount.value).toBe(0)
    expect(perf.longDoc.value).toBe(false)
    expect(perf.highlightHtml.value).toBe(ZWSP)
    expect(alerts).toBe(0)
    scope.stop()
  })

  test('一次性粘贴长文本达到阈值：字数正确、提示一次、重复超阈值不重复打扰', async () => {
    const fc = fakeClock()
    const { doc, session } = setup()
    let alerts = 0

    const scope = effectScope()
    const perf = scope.run(() =>
      useEditorPerf(session as any, doc as any, { clock: fc.clock, onLongDocEnter: () => alerts++ }),
    )!
    await renderFrame(fc)

    // 模拟粘贴：空文档 → 50,000 字符（跨越阈值的单次变更）
    doc.text = 'a'.repeat(LONG_DOC_WARN_CHARS)
    await renderFrame(fc)

    expect(perf.charCount.value).toBe(LONG_DOC_WARN_CHARS)
    expect(perf.longDoc.value).toBe(true)
    expect(alerts).toBe(1)
    expect(perf.highlightHtml.value.includes('aaaa')).toBeTruthy()

    // 继续输入仍在阈值之上：不再弹提示
    doc.text += 'b'.repeat(100)
    await renderFrame(fc)
    expect(alerts).toBe(1)
    expect(perf.charCount.value).toBe(LONG_DOC_WARN_CHARS + 100)

    // 回落到阈值以下后再次超过：可再次提示
    doc.text = 'short'
    await renderFrame(fc)
    expect(perf.longDoc.value).toBe(false)
    doc.text = 'c'.repeat(LONG_DOC_WARN_CHARS)
    await renderFrame(fc)
    expect(alerts).toBe(2)
    scope.stop()
  })
})

describe('高亮层节流（多人远程光标高频更新）', () => {
  test('一个节流窗口内的连发光标更新只渲染一次，且结果为末次位置', async () => {
    const fc = fakeClock()
    const { doc, session } = setup()
    doc.text = 'a'.repeat(LONG_DOC_WARN_CHARS) // 大文档场景

    const scope = effectScope()
    const perf = scope.run(() => useEditorPerf(session as any, doc as any, { clock: fc.clock }))!
    let renders = 0
    scope.run(() => watch(() => perf.highlightHtml.value, () => renders++))
    await renderFrame(fc) // 初始渲染
    const rendersAtStart = renders

    // 两个协作者各发 10 次光标，全部落在同一个 120ms 窗口内
    for (let i = 1; i <= 10; i++) {
      session.cursors.u1 = { start: i * 10, end: i * 10 }
      session.cursors.u2 = { start: i * 20, end: i * 20 }
      fc.advance(10) // 10×10ms = 100ms < 120ms
    }
    // 窗口未到：不产生任何渲染（中间位置全部被合并）
    expect(renders).toBe(rendersAtStart)
    expect(fc.pendingTimers()).toBe(1)

    fc.advance(REMOTE_CURSOR_REFRESH_MS) // t=220，定时在 t=120 的 trailing 触发
    await renderFrame(fc)

    // 20 次光标更新只换来 1 次全量重算（无节流时为 20 次）
    expect(renders).toBe(rendersAtStart + 1)
    // 末次位置生效：u1@100、u2@200（光标标记为插入点，渲染出两名协作者）
    const html = perf.highlightHtml.value
    expect(html.includes('Alice')).toBeTruthy()
    expect(html.includes('Bob')).toBeTruthy()
    expect(html.match(/class="remote-caret"/g)?.length ?? 0).toBe(2)

    scope.stop()
  })

  test('超过节流间隔后的更新在下一帧渲染（trailing 不丢最终状态）', async () => {
    const fc = fakeClock()
    const { doc, session } = setup()
    doc.text = 'x'.repeat(1000)

    const scope = effectScope()
    const perf = scope.run(() => useEditorPerf(session as any, doc as any, { clock: fc.clock }))!
    let renders = 0
    scope.run(() => watch(() => perf.highlightHtml.value, () => renders++))
    await renderFrame(fc)
    const n0 = renders

    session.cursors.u1 = { start: 10, end: 10 }
    fc.advance(REMOTE_CURSOR_REFRESH_MS)
    await renderFrame(fc)
    expect(renders).toBe(n0 + 1)

    session.cursors.u1 = { start: 90, end: 90 }
    fc.advance(REMOTE_CURSOR_REFRESH_MS)
    await renderFrame(fc)
    expect(renders).toBe(n0 + 2)
    expect(perf.highlightHtml.value.includes('Alice')).toBeTruthy()
    scope.stop()
  })

  test('等待光标节流期间发生本地编辑：doc 通道立即渲染并取消挂起的光标定时', async () => {
    const fc = fakeClock()
    const { doc, session } = setup()
    doc.text = 'a'.repeat(1000)

    const scope = effectScope()
    const perf = scope.run(() => useEditorPerf(session as any, doc as any, { clock: fc.clock }))!
    let renders = 0
    scope.run(() => watch(() => perf.highlightHtml.value, () => renders++))
    await renderFrame(fc)
    const n0 = renders

    session.cursors.u1 = { start: 1, end: 1 }
    fc.advance(30) // 距下次渲染还差 90ms
    expect(fc.pendingTimers()).toBe(1)
    expect(renders).toBe(n0)

    // 本地输入：doc 通道不等节流间隔
    doc.text += '!'
    await renderFrame(fc)
    expect(renders).toBe(n0 + 1)
    expect(perf.highlightHtml.value.endsWith('!' + ZWSP)).toBeTruthy()
    // 挂起的光标定时已被取消，120ms 后不产生额外渲染
    expect(fc.pendingTimers()).toBe(0)
    fc.advance(REMOTE_CURSOR_REFRESH_MS + 50)
    await renderFrame(fc)
    expect(renders).toBe(n0 + 1)
    scope.stop()
  })

  test('scope 销毁后清理定时器与帧，不再渲染', async () => {
    const fc = fakeClock()
    const { doc, session } = setup()
    const scope = effectScope()
    const perf = scope.run(() => useEditorPerf(session as any, doc as any, { clock: fc.clock }))!
    let renders = 0
    scope.run(() => watch(() => perf.highlightHtml.value, () => renders++))
    await renderFrame(fc)
    expect(renders).toBe(1) // 初始渲染

    session.cursors.u1 = { start: 1, end: 1 }
    expect(fc.pendingTimers()).toBe(1)
    scope.stop()
    expect(fc.pendingTimers()).toBe(0)
    expect(fc.pendingFrames()).toBe(0)

    fc.advance(REMOTE_CURSOR_REFRESH_MS * 2)
    fc.flushFrame()
    expect(renders).toBe(1) // 销毁后无新增渲染
  })
})
