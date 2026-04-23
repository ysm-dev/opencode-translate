const DISPLAY_LANGUAGE_LABELS: Record<string, string> = {
  en: "English translation",
  ko: "한국어 번역",
  ja: "日本語訳",
  zh: "中文翻译",
  "zh-CN": "简体中文翻译",
  "zh-TW": "繁體中文翻譯",
  de: "Deutsche Übersetzung",
  fr: "Traduction française",
  es: "Traducción al español",
}

export function getDisplayLanguageLabel(displayLanguage: string): string {
  return DISPLAY_LANGUAGE_LABELS[displayLanguage] ?? `Translation (${displayLanguage})`
}

export { DISPLAY_LANGUAGE_LABELS }
