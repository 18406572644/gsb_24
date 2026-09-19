// @vitest-environment jsdom
import { describe, test, expect, vi, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import EditorView from '@/components/EditorView.vue'
import { useDocStore } from '@/stores/doc'
import { useSessionStore } from '@/stores/session'
import { LONG_DOC_WARN_CHARS, formatCharCount } from '@/perf'

// 隔离协同层单例：组件挂载只用到 onRemoteApplied 注册与光标上报
vi.mock('@/collab/collab', () => ({
  collab: {
    onRemoteApplied: () => () => {},
    localEdit: () => {},
    sendCursor: () => {},
    addAnnotation: () => {},
  },
}))

function mountEditor() {
  const pinia = createPinia()
  const wrapper = mount(EditorView, {
    global: { plugins: [pinia, ElementPlus] },
  })
  return { wrapper, doc: useDocStore(pinia), session: useSessionStore(pinia) }
}

/** 推进 rAF（组件的立即渲染通道）并等待 Vue 队列 */
async function frame() {
  await new Promise((r) => requestAnimationFrame(() => r(null)))
  await nextTick()
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('EditorView 顶部统计条（真实组件挂载）', () => {
  test('空文档：显示「正文字数：0」且无性能提示标签', async () => {
    const { wrapper } = mountEditor()
    await frame()
    const count = wrapper.find('.char-count')
    expect(count.exists()).toBe(true)
    expect(count.text()).toContain('0')
    expect(wrapper.find('.perf-tag').exists()).toBe(false)
    wrapper.unmount()
  })

  test('长文本粘贴：字数更新、出现性能提示标签、阈值之上不重复弹消息', async () => {
    const { wrapper, doc } = mountEditor()
    await frame()

    // 模拟一次性粘贴长文本（跨越阈值）
    doc.text = 'a'.repeat(LONG_DOC_WARN_CHARS)
    await frame()

    expect(wrapper.find('.char-count').text()).toContain(formatCharCount(LONG_DOC_WARN_CHARS))
    const tag = wrapper.find('.perf-tag')
    expect(tag.exists()).toBe(true)
    expect(tag.text()).toContain('大文档')

    // ElMessage.warning 挂载到 body，仅提示一次
    const warnings1 = document.querySelectorAll('.el-message--warning')
    expect(warnings1.length).toBe(1)
    expect(warnings1[0]!.textContent ?? '').toContain(formatCharCount(LONG_DOC_WARN_CHARS))

    // 阈值之上继续编辑：不再弹消息
    doc.text += 'b'.repeat(10)
    await frame()
    expect(document.querySelectorAll('.el-message--warning').length).toBe(1)

    wrapper.unmount()
  })
})
