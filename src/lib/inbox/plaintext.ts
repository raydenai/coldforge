/**
 * Plain-text rendering for saved email bodies.
 *
 * Saved inbound/outbound HTML is untrusted external content and must never be
 * injected into the operator origin. These helpers convert stored HTML into a
 * plain string; callers render the result as a React text child (which React
 * escapes), never via `dangerouslySetInnerHTML`.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/**
 * Convert an HTML string to plain text without emitting any markup.
 * Raw-text containers (script/style/iframe/...) are removed with their content,
 * including an unterminated opening tag so a truncated body cannot leak markup.
 */
export function stripHtmlToPlainText(html: string): string {
  if (!html) return ''
  const text = html
    // Remove raw-text containers together with their contents; allow a missing close tag.
    .replace(/<(script|style|iframe|object|embed|template|noscript|svg|math)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    // Preserve visible line structure before stripping tags.
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article|table|ul|ol)>/gi, '\n\n')
    // Remove every remaining tag.
    .replace(/<[^>]*>/g, ' ')
    // Decode a bounded set of entities so visible characters survive.
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      const key = entity.toLowerCase()
      const named = NAMED_ENTITIES[key]
      if (named !== undefined) return named
      if (key.startsWith('#')) {
        const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
      }
      return match
    })
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/**
 * Resolve the safe display text for a saved message. A measured plain-text body
 * wins when present; otherwise an HTML-only body is converted to text.
 */
export function messagePlainText(
  bodyText: string | null | undefined,
  bodyHtml: string | null | undefined,
): string {
  if (typeof bodyText === 'string' && bodyText.trim().length > 0) return bodyText
  if (typeof bodyHtml === 'string' && bodyHtml.trim().length > 0) return stripHtmlToPlainText(bodyHtml)
  return typeof bodyText === 'string' ? bodyText : ''
}
