/**
 * 高亮背景层 HTML 构建（纯函数）。
 *
 * 从 EditorView.vue 抽出，便于在无 DOM 环境下单测；
 * 输入为某一时刻的文档 / 批注 / 远程光标快照，输出 backdrop 的 innerHTML。
 */
import type { Annotation } from '../../shared/protocol'

export interface HighlightUser {
  clientId: string
  name: string
  color: string
}

export interface HighlightInput {
  text: string
  annotations: Annotation[]
  activeAnnId: string | null
  /** 自己的 clientId，自身光标不在背景层绘制 */
  me: string
  cursors: Record<string, { start: number; end: number }>
  users: HighlightUser[]
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function caretHtml(name: string, color: string): string {
  return `<span class="remote-caret" style="--c:${color}"><i class="remote-flag">${escapeHtml(name)}</i></span>`
}

export function buildHighlightHtml(input: HighlightInput): string {
  const { text, annotations, activeAnnId, me, cursors, users } = input

  const bounds = new Set<number>([0, text.length])
  for (const a of annotations) {
    bounds.add(a.start)
    bounds.add(a.end)
  }

  // 远程选区与光标
  const remoteSels: { start: number; end: number; color: string }[] = []
  const carets = new Map<number, { name: string; color: string }[]>()
  for (const [cid, c] of Object.entries(cursors)) {
    if (cid === me) continue
    const u = users.find((x) => x.clientId === cid)
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
  for (const a of annotations) {
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
      html += `<span class="ann-orphan-mark${id === activeAnnId ? ' active' : ''}"></span>`
    }
    const e = i + 1 < sorted.length ? sorted[i + 1] : null
    if (e === null || e <= s) continue
    const segText = escapeHtml(text.slice(s, e))
    const classes: string[] = []
    let style = ''
    for (const a of annotations) {
      if (a.orphan) continue
      if (a.start < e && a.end > s) {
        classes.push('hl-ann')
        if (a.resolved) classes.push('resolved')
        if (a.id === activeAnnId) classes.push('active')
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
}
