'use client'

import { cn } from '@/lib/utils'
import { messagePlainText } from '@/lib/inbox/plaintext'

export interface MessageBodyProps {
  bodyText: string
  bodyHtml?: string | null
  className?: string
}

/**
 * Renders a saved email body as escaped plain text.
 *
 * Stored HTML is never interpreted: `bodyHtml` is converted to text and React
 * escapes the resulting text node by construction. Do not replace this with
 * `dangerouslySetInnerHTML` without a reviewed sanitizer/sandbox contract.
 */
export function MessageBody({ bodyText, bodyHtml, className }: MessageBodyProps) {
  const text = messagePlainText(bodyText, bodyHtml)
  if (!text) return null
  return <div className={cn('whitespace-pre-wrap break-words', className)}>{text}</div>
}
