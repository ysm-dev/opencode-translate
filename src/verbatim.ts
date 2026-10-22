// Finds source spans that a translation dropped. Only spans every language copies
// unchanged are checked, and nothing is masked or rewritten, so this cannot strand
// ordinary words the way the old placeholder pipeline did (docs/spec.en.md §7).
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
const URL = /https?:\/\/[\w\-.~:/?#@!$&+,;=%]+/g
const PATH = /(?:[\w.-]+\/)+[\w-]+\.[A-Za-z0-9]{1,8}(?![\w/])/g
// Phone numbers and IDs. Dates, decimals, and grouped quantities are left out:
// translations legitimately localize those.
const NUMBER = /(?<![\w+-])\+?\d[\d-]{5,}\d(?![\w-])(?!\.\d)/g
const CODE = /(?<!`)`([^`\n]+)`(?!`)/g

function digits(text: string) {
  return text.replace(/\D/g, "")
}

function spans(text: string) {
  const found = new Set<string>()
  for (const [email] of text.matchAll(EMAIL)) found.add(email.replace(/^[._+-]+|[._-]+$/g, ""))
  for (const [url] of text.matchAll(URL)) found.add(url.replace(/[.,;:!?_]+$/, ""))
  for (const [path] of text.matchAll(PATH)) found.add(path)
  for (const [number] of text.matchAll(NUMBER)) if (digits(number).length >= 9) found.add(number)
  for (const [, code] of text.matchAll(CODE)) {
    // Technical spans only: ASCII without spaces, with a symbol or digit beyond
    // sentence punctuation. Labels such as `Save` or `Open...` may be translated.
    const technical = /[\d/._:@$=#\\{}[\]<>]|\w\(/.test(code.replace(/[.,:;!?]+$/, ""))
    if (technical && /^[\x21-\x7e]+$/.test(code)) found.add(code)
  }
  return [...found]
}

export function missingVerbatim(source: string, translation: string): string[] {
  // A translation may regroup a phone number ("+82 10-9283-6686"), so compare digits.
  const regrouped = translation.replace(/(?<=\d)[\s().,-]+(?=\d)/g, "")
  return spans(source).filter((span) =>
    /^\+?\d[\d-]*$/.test(span) ? !regrouped.includes(digits(span)) : !translation.includes(span),
  )
}
