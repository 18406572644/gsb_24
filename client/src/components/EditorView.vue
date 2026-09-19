<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useSessionStore } from '@/stores/session'
import { useDocStore } from '@/stores/doc'
import { collab } from '@/collab/collab'
import { mapPosition } from '../../../shared/ot'
import {
  COUNT_THROTTLE_MS,
  HIGHLIGHT_THROTTLE_MS,
  PERF_HINT_THRESHOLD,
  createThrottle,
  formatCharCount,
  shouldWarnPerf,
} from '@/utils/perfGuard'

const session = useSessionStore()
const doc = useDocStore()

const wrapRef = ref<HTMLElement>()
const taRef = ref<HTMLTextAreaElement>()
const backdropRef = ref<HTMLElement>()

/** IME 组合输入中（中文输入法），期间不做 diff，避免把拼音中间态当作操作 */
let composing = false

/* ---------------- 高亮渲染（backdrop 层） ---------------- */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function caretHtml(name: string, color: string): string {
  return `<span class="remote-caret" style="--c:${color}"><i class="remote-flag">${escapeHtml(name)}</i></span>`
}

const highlightHtml = computed(() => {
  const text = doc.text
  const anns = doc.annotations
  const me = session.clientId

  const bounds = new Set<number>([0, text.length])
  for (const a of anns) {
    bounds.add(a.start)
    bounds.add(a.end)
  }

  // 远程选区与光标
  const remoteSels: { start: number; end: number; color: string }[] = []
  const carets = new Map<number, { name: string; color: string }[]>()
  for (const [cid, c] of Object.entries(session.cursors)) {
    if (cid === me) continue
    const u = session.users.find((x) => x.clientId === cid)
    if (!u) continue
    const s = Math.max(0, Math.min(c.start, c.end, text.length))
    const e = Math.max(0, Math.min(Math.max(c.start, c.end), text.length))
    if (s !== e) {
      remoteSels.push({ start: s, end: e, color: u.color })
      bounds.add(s)
      bounds.add(e)
    }
    const pos = Math.min(e, text.length)
    bounds.add(pos)
    if (!carets.has(pos)) carets.set(pos, [])
    carets.get(pos)!.push({ name: u.name, color: u.color })
  }

  // 孤儿批注（锚点文本被删除）位置
  const orphanAt = new Map<number, string[]>()
  for (const a of anns) {
    if (!a.orphan) continue
    bounds.add(a.start)
    if (!orphanAt.has(a.start)) orphanAt.set(a.start, [])
    orphanAt.get(a.start)!.push(a.id)
  }

  const sorted = [...bounds].sort((a, b) => a - b)
  let html = ''
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]
    // 该边界点上的光标与孤儿标记
    for (const c of carets.get(s) ?? []) html += caretHtml(c.name, c.color)
    for (const id of orphanAt.get(s) ?? []) {
      html += `<span class="ann-orphan-mark${id === doc.activeAnnId ? ' active' : ''}"></span>`
    }
    const e = i + 1 < sorted.length ? sorted[i + 1] : null
    if (e === null || e <= s) continue
    const segText = escapeHtml(text.slice(s, e))
    const classes: string[] = []
    let style = ''
    for (const a of anns) {
      if (a.orphan) continue
      if (a.start < e && a.end > s) {
        classes.push('hl-ann')
        if (a.resolved) classes.push('resolved')
        if (a.id === doc.activeAnnId) classes.push('active')
      }
    }
    for (const r of remoteSels) {
      if (r.start < e && r.end > s) {
        classes.push('hl-remote-sel')
        style = `background:${r.color}33`
      }
    }
    html += classes.length
      ? `<span class="${classes.join(' ')}"${style ? ` style="${style}"` : ''}>${segText}</span>`
      : segText
  }
  // 末尾零宽字符：保证最后一行（空行）高度与 textarea 一致
  return html + '\u200b'
})

/* ---------------- 大文档性能保护：高频刷新节流 ---------------- */

/**
 * 实际渲染到 backdrop 的 HTML。
 * highlightHtml 的任一依赖变化都会全量重算整层 HTML，大文档下单次成本高；
 * 多人协作时远程光标消息（每用户约 120ms 一条）会高频触发该重算，引发卡顿。
 * 因此：
 * - 正文变化：立即刷新，保证 backdrop 与 textarea 严格对齐（否则高亮错位）；
 * - 远程光标 / 批注标记 / 激活态等指示变化：节流合并，最多每 200ms 重算一次。
 */
const renderedHighlightHtml = ref(highlightHtml.value)
let lastRenderedText = doc.text

const throttledRenderHighlight = createThrottle(() => {
  renderedHighlightHtml.value = highlightHtml.value
  lastRenderedText = doc.text
}, HIGHLIGHT_THROTTLE_MS)

watch(highlightHtml, () => {
  if (doc.text !== lastRenderedText) {
    throttledRenderHighlight.cancel()
    renderedHighlightHtml.value = highlightHtml.value
    lastRenderedText = doc.text
  } else {
    throttledRenderHighlight()
  }
})

/* ---------------- 正文字符统计与性能提示（节流刷新） ---------------- */

/** 状态条显示的字符数：输入/粘贴/远程操作都会高频改变它，节流刷新避免每次按键重渲染 */
const displayCharCount = ref(doc.text.length)

const throttledUpdateCount = createThrottle(() => {
  displayCharCount.value = doc.text.length
}, COUNT_THROTTLE_MS)

watch(
  () => doc.text.length,
  () => throttledUpdateCount(),
)

/** 超过预设阈值：提示性能影响（协作高亮已降频） */
const perfWarn = computed(() => shouldWarnPerf(displayCharCount.value))

/* ---------------- 滚动同步 ---------------- */

function syncScroll() {
  const bd = backdropRef.value
  const ta = taRef.value
  if (bd && ta) {
    bd.scrollTop = ta.scrollTop
    bd.scrollLeft = ta.scrollLeft
  }
}

watch(
  () => doc.text,
  () => nextTick(syncScroll),
)

/* ---------------- 位置测量（镜像 div 技术） ---------------- */

function measurePos(pos: number): { top: number; left: number } {
  const ta = taRef.value!
  const cs = getComputedStyle(ta)
  const div = document.createElement('div')
  div.style.cssText = `position:absolute;top:0;left:0;visibility:hidden;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;width:${ta.clientWidth}px;padding:${cs.padding};border-width:0;font-family:${cs.fontFamily};font-size:${cs.fontSize};line-height:${cs.lineHeight};letter-spacing:${cs.letterSpacing};tab-size:2;`
  div.textContent = doc.text.slice(0, pos)
  const marker = document.createElement('span')
  marker.textContent = '\u200b'
  div.appendChild(marker)
  wrapRef.value!.appendChild(div)
  const r = { top: marker.offsetTop, left: marker.offsetLeft }
  div.remove()
  return r
}

/* ---------------- 输入与选区 ---------------- */

function onInput() {
  if (composing) return
  const ta = taRef.value
  if (!ta) return
  collab.localEdit(ta.value)
  reportSelection()
}

function onCompositionStart() {
  composing = true
}

function onCompositionEnd() {
  composing = false
  onInput()
}

const annFabPos = ref<{ top: number; left: number } | null>(null)
const annPopVisible = ref(false)
const annDraft = ref('')

function reportSelection() {
  const ta = taRef.value
  if (!ta) return
  const s = ta.selectionStart
  const e = ta.selectionEnd
  doc.selection = s !== e ? { start: s, end: e } : null
  collab.sendCursor(s, e)
  updateAnnFab()
}

function updateAnnFab() {
  if (annPopVisible.value) return
  if (doc.selection && session.canAnnotate) {
    const p = measurePos(doc.selection.end)
    const ta = taRef.value!
    const wrap = wrapRef.value!
    annFabPos.value = {
      top: Math.min(p.top - ta.scrollTop + 26, wrap.clientHeight - 44),
      left: Math.max(8, Math.min(p.left - ta.scrollLeft, wrap.clientWidth - 110)),
    }
  } else {
    annFabPos.value = null
  }
}

function openAnnPop() {
  annPopVisible.value = true
  annDraft.value = ''
}

function closeAnnPop() {
  annPopVisible.value = false
  annFabPos.value = null
}

function submitAnn() {
  const sel = doc.selection
  const text = annDraft.value.trim()
  if (!sel || !text) {
    if (!text) ElMessage.warning('请输入批注内容')
    return
  }
  collab.addAnnotation(sel.start, sel.end, doc.text.slice(sel.start, sel.end), text)
  closeAnnPop()
  taRef.value?.focus()
}

/* ---------------- 远程操作：重映射本地选区 ---------------- */

let unregisterRemote: (() => void) | null = null

onMounted(() => {
  unregisterRemote = collab.onRemoteApplied((op) => {
    const ta = taRef.value
    if (!ta) return
    const s = mapPosition(ta.selectionStart, op, 'before')
    const e = mapPosition(ta.selectionEnd, op, 'before')
    const scroll = ta.scrollTop
    nextTick(() => {
      if (!taRef.value) return
      taRef.value.setSelectionRange(s, e)
      taRef.value.scrollTop = scroll
      reportSelection()
    })
  })
})

onBeforeUnmount(() => {
  unregisterRemote?.()
  throttledRenderHighlight.cancel()
  throttledUpdateCount.cancel()
})

/* ---------------- 批注定位 ---------------- */

watch(
  () => doc.locateTarget,
  (t) => {
    if (!t) return
    const ann = doc.annotations.find((a) => a.id === t.annId)
    const ta = taRef.value
    if (!ann || !ta) return
    nextTick(() => {
      ta.focus()
      ta.setSelectionRange(ann.start, ann.end)
      const p = measurePos(ann.start)
      ta.scrollTop = Math.max(0, p.top - 80)
      syncScroll()
      reportSelection()
    })
  },
)
</script>

<template>
  <div class="editor-root">
    <div class="editor-status">
      <span class="char-count" :class="{ warn: perfWarn }">正文 {{ formatCharCount(displayCharCount) }} 字符</span>
      <el-tooltip
        v-if="perfWarn"
        :content="`已超过 ${formatCharCount(PERF_HINT_THRESHOLD)} 字符的性能阈值：协作高亮刷新已降频，编辑可能出现卡顿`"
        placement="bottom"
      >
        <el-tag size="small" type="warning" effect="light">⚠ 文档较大，性能可能受影响</el-tag>
      </el-tooltip>
    </div>
    <div ref="wrapRef" class="editor-wrap">
      <div ref="backdropRef" class="editor-backdrop" aria-hidden="true">
        <div class="backdrop-content" v-html="renderedHighlightHtml"></div>
      </div>
      <textarea
        ref="taRef"
        class="editor-textarea"
        :value="doc.text"
        :readonly="!session.canEdit"
        :placeholder="session.canEdit ? '开始输入，内容将实时同步给协作者…' : '当前身份为只读/批注，无法编辑正文'"
        spellcheck="false"
        @input="onInput"
        @scroll="syncScroll"
        @select="reportSelection"
        @compositionstart="onCompositionStart"
        @compositionend="onCompositionEnd"
      ></textarea>

      <div v-if="annFabPos && !annPopVisible" class="ann-fab" :style="{ top: annFabPos.top + 'px', left: annFabPos.left + 'px' }">
        <el-button size="small" type="warning" @click="openAnnPop">💬 批注</el-button>
      </div>

      <div v-if="annPopVisible && annFabPos" class="ann-pop" :style="{ top: annFabPos.top + 'px', left: annFabPos.left + 'px' }">
        <el-input
          v-model="annDraft"
          type="textarea"
          :rows="3"
          maxlength="500"
          placeholder="输入批注内容…"
          @keydown.esc="closeAnnPop"
        />
        <div class="ann-pop-actions">
          <el-button size="small" @click="closeAnnPop">取消</el-button>
          <el-button size="small" type="primary" @click="submitAnn">提交</el-button>
        </div>
      </div>
    </div>
  </div>
</template>
