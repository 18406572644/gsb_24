/**
 * 大文档性能保护（client/src/utils/perfGuard.ts）验收测试。
 * 覆盖场景：空文档、阈值边界、长文本粘贴、多人远程光标高频更新下的刷新节流。
 * 被测模块为纯 TS（无 Vue/DOM 依赖），可直接在 node:test 下运行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COUNT_THROTTLE_MS,
  HIGHLIGHT_THROTTLE_MS,
  PERF_HINT_THRESHOLD,
  createThrottle,
  formatCharCount,
  shouldWarnPerf,
} from '../../client/src/utils/perfGuard'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 空文档 ---------------- */

test('空文档：字符数为 0，不触发性能提示', () => {
  assert.equal(shouldWarnPerf(0), false)
  assert.equal(formatCharCount(0), '0')
})

/* ---------------- 阈值边界 ---------------- */

test('阈值边界：恰好等于阈值不提示，超过才提示', () => {
  assert.equal(shouldWarnPerf(PERF_HINT_THRESHOLD), false)
  assert.equal(shouldWarnPerf(PERF_HINT_THRESHOLD + 1), true)
  assert.ok(PERF_HINT_THRESHOLD > 0)
})

/* ---------------- 长文本粘贴 ---------------- */

test('长文本粘贴：20 万字符触发性能提示，统计显示千分位格式化', () => {
  const pastedLength = 200_000 // 模拟一次性粘贴长文本后的正文长度
  assert.equal(shouldWarnPerf(pastedLength), true)
  assert.equal(formatCharCount(pastedLength), '200,000')
  assert.equal(formatCharCount(1234567), '1,234,567')
  assert.equal(formatCharCount(999), '999')
})

/* ---------------- 多人远程光标高频更新：刷新节流 ---------------- */

test('高频更新被节流合并：突发 50 次远程光标刷新仅执行 2 次（首次立即 + 尾随合并）', async () => {
  let renders = 0
  const throttled = createThrottle(() => {
    renders++
  }, HIGHLIGHT_THROTTLE_MS)

  // 模拟多名协作者光标消息风暴（每用户约 120ms 一条，汇聚后远超渲染承受能力）
  for (let i = 0; i < 50; i++) throttled()
  assert.equal(renders, 1) // 首次立即执行，其余进入节流窗口

  await sleep(HIGHLIGHT_THROTTLE_MS + 60)
  assert.equal(renders, 2) // 整个突发合并为一次尾随执行
  throttled.cancel()
})

test('尾随执行读取最新状态：突发期间的光标位置以最后一次为准', async () => {
  const rendered: number[] = []
  let latestCursor = 0
  const throttled = createThrottle(() => {
    rendered.push(latestCursor)
  }, HIGHLIGHT_THROTTLE_MS)

  throttled() // 立即渲染光标 0
  latestCursor = 42 // 突发期间状态持续变化
  throttled()
  latestCursor = 99
  throttled()

  await sleep(HIGHLIGHT_THROTTLE_MS + 60)
  assert.deepEqual(rendered, [0, 99]) // 尾随执行携带最新值，中间态被丢弃
  throttled.cancel()
})

test('节流窗口过后再次更新立即执行', async () => {
  let renders = 0
  const throttled = createThrottle(() => {
    renders++
  }, HIGHLIGHT_THROTTLE_MS)

  throttled()
  assert.equal(renders, 1)
  await sleep(HIGHLIGHT_THROTTLE_MS + 60)
  throttled()
  assert.equal(renders, 2) // 窗口已过，立即执行
  throttled.cancel()
})

test('cancel 取消挂起的尾随执行（组件卸载场景）', async () => {
  let renders = 0
  const throttled = createThrottle(() => {
    renders++
  }, HIGHLIGHT_THROTTLE_MS)

  throttled()
  throttled() // 产生挂起的尾随执行
  throttled.cancel()
  await sleep(HIGHLIGHT_THROTTLE_MS + 60)
  assert.equal(renders, 1) // 尾随执行已被取消
})

/* ---------------- 常量合理性 ---------------- */

test('节流间隔配置合理：统计刷新不早于高亮刷新', () => {
  assert.ok(HIGHLIGHT_THROTTLE_MS >= 100) // 不低于远程光标上报间隔（120ms）量级
  assert.ok(COUNT_THROTTLE_MS >= HIGHLIGHT_THROTTLE_MS)
})
