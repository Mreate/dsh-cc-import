/**
 * 浏览器 UI 语言（host 侧缓存）。
 *
 * host 无法直接读取浏览器语言，由客户端半在页面加载时经
 * `/api/cc-import/lang` 上报（见 src/rpc.ts 与 src/client/index.ts）。
 * 默认英文；浏览器语言以 `zh` 开头视为中文。
 *
 * 该状态只用于 /init 的提问题面、结果消息等"运行时"文案——命令描述是
 * 注册时固定的静态字符串（dsh-commands 要求 description 为非空 string，
 * 无更新 API，客户端 remote 亦只读），无法按浏览器语言展示，固定用英文
 * （见 src/init.ts）。
 */

export type UiLang = 'en' | 'zh'

let current: UiLang = 'en'

/** 浏览器语言（如 navigator.language 的 'zh-CN' / 'en-US'）归一化为 UiLang。 */
export function normalizeUiLang(lang: string | undefined): UiLang {
  return lang && /^zh/i.test(lang) ? 'zh' : 'en'
}

export function getUiLang(): UiLang {
  return current
}

export function setUiLang(lang: string | undefined): UiLang {
  current = normalizeUiLang(lang)
  return current
}
