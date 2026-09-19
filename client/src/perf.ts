/**
 * 前端性能保护参数与判定（仅影响提示与渲染节流，不涉及 OT 协议）。
 */

/** 正文长度告警阈值（字符数，按 JS 字符串长度计）：达到该值后提示性能影响 */
export const LONG_DOC_WARN_CHARS = 50_000

/** 远程光标高亮层的最小刷新间隔（ms），多人高频光标更新在此通道合并 */
export const REMOTE_CURSOR_REFRESH_MS = 120

/** 是否为大文档（达到阈值即提示） */
export function isLongDoc(length: number): boolean {
  return length >= LONG_DOC_WARN_CHARS
}

/** 字符数展示格式：50000 -> "50,000" */
export function formatCharCount(n: number): string {
  return n.toLocaleString('en-US')
}
