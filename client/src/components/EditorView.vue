<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useSessionStore } from '@/stores/session'
import { useDocStore } from '@/stores/doc'
import { collab } from '@/collab/collab'
import { mapPosition } from '../../../shared/ot'
import { useEditorPerf } from '@/useEditorPerf'
import { formatCharCount, LONG_DOC_WARN_CHARS } from '@/perf'

const session = useSessionStore()
const doc = useDocStore()

const wrapRef = ref<HTMLElement>()
const taRef = ref<HTMLTextAreaElement>()
const backdropRef = ref<HTMLElement>()

/** IME 组合输入中（中文输入法），期间不做 diff，避免把拼音中间态当作操作 */
let composing = false

/* ---------------- 正文字符统计、大文档提示、高亮层节流 ---------------- */

const { highlightHtml, charCount, longDoc } = useEditorPerf(session, doc, {
  // 跨越阈值时（如一次性粘贴长文本）弹出一次提示；回落后再次超过可再次提示
  onLongDocEnter: () => {
    ElMessage.warning(
      `正文已超过 ${formatCharCount(LONG_DOC_WARN_CHARS)} 字符，大文档下高亮重算开销较高，远程光标刷新已自动节流`,
    )
  },
})

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

onBeforeUnmount(() => unregisterRemote?.())

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
  <div class="editor-pane-inner">
    <div class="editor-statusbar">
      <span class="char-count" :class="{ 'is-long': longDoc }">
        正文字数：<strong>{{ formatCharCount(charCount) }}</strong>
      </span>
      <el-tooltip
        v-if="longDoc"
        placement="bottom-start"
        :content="`正文达到 ${formatCharCount(LONG_DOC_WARN_CHARS)} 字符以上时，批注高亮与远程光标的全量重算开销较大；多人光标更新已自动节流以降低卡顿，本地编辑不受影响`"
      >
        <el-tag size="small" type="warning" effect="light" class="perf-tag">
          ⚠ 大文档可能影响渲染性能（光标刷新已节流）
        </el-tag>
      </el-tooltip>
    </div>

    <div ref="wrapRef" class="editor-wrap">
      <div ref="backdropRef" class="editor-backdrop" aria-hidden="true">
        <div class="backdrop-content" v-html="highlightHtml"></div>
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
