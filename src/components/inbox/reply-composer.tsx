'use client'

import * as React from 'react'
import { useRef, useEffect, useCallback, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Send,
  Loader2,
  X,
  Bold,
  Italic,
  Link,
  Paperclip,
  Clock,
  MoreHorizontal,
  Trash2,
  Save,
} from 'lucide-react'

interface ReplyComposerProps {
  recipientEmail: string
  recipientName?: string | null
  defaultMessage?: string
  onSend: (message: string) => Promise<void>
  onCancel?: () => void
  onSaveDraft?: (message: string) => void
  placeholder?: string
  minHeight?: number
  maxHeight?: number
  showToolbar?: boolean
  autoFocus?: boolean
  disabled?: boolean
  className?: string
}

/**
 * ReplyComposer - Rich text reply composer with basic formatting
 */
export function ReplyComposer({
  recipientEmail,
  recipientName,
  defaultMessage = '',
  onSend,
  onCancel,
  onSaveDraft,
  placeholder = 'Write your reply...',
  minHeight = 120,
  maxHeight = 300,
  showToolbar = true,
  autoFocus = true,
  disabled = false,
  className,
}: ReplyComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [message, setMessage] = useState(defaultMessage)
  const [isSending, setIsSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  // Auto-focus on mount
  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [autoFocus])

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    textarea.style.height = 'auto'
    const newHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)
    textarea.style.height = `${newHeight}px`
  }, [message, minHeight, maxHeight])

  // Handle send
  const handleSend = useCallback(async () => {
    if (!message.trim() || isSending || disabled) return

    try {
      setIsSending(true)
      setSendError(null)
      await onSend(message)
      setMessage('')
    } catch (error) {
      console.error('Failed to send reply:', error)
      setSendError(error instanceof Error && error.message ? error.message : 'Failed to send reply')
    } finally {
      setIsSending(false)
    }
  }, [message, isSending, disabled, onSend])

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl + Enter to send
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSend()
      return
    }

    // Escape to cancel
    if (e.key === 'Escape' && onCancel) {
      e.preventDefault()
      onCancel()
      return
    }

    // Basic formatting shortcuts
    if (showToolbar && (e.metaKey || e.ctrlKey)) {
      const textarea = textareaRef.current
      if (!textarea) return

      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const selectedText = message.substring(start, end)

      let newText = ''
      let newCursorPos = start

      switch (e.key) {
        case 'b': // Bold
          e.preventDefault()
          if (selectedText) {
            newText = message.substring(0, start) + `**${selectedText}**` + message.substring(end)
            newCursorPos = end + 4
          } else {
            newText = message.substring(0, start) + '****' + message.substring(end)
            newCursorPos = start + 2
          }
          setMessage(newText)
          setTimeout(() => {
            textarea.selectionStart = textarea.selectionEnd = newCursorPos
          }, 0)
          break

        case 'i': // Italic
          e.preventDefault()
          if (selectedText) {
            newText = message.substring(0, start) + `*${selectedText}*` + message.substring(end)
            newCursorPos = end + 2
          } else {
            newText = message.substring(0, start) + '**' + message.substring(end)
            newCursorPos = start + 1
          }
          setMessage(newText)
          setTimeout(() => {
            textarea.selectionStart = textarea.selectionEnd = newCursorPos
          }, 0)
          break

        case 'k': // Link
          e.preventDefault()
          const url = window.prompt('Enter URL:')
          if (url) {
            if (selectedText) {
              newText = message.substring(0, start) + `[${selectedText}](${url})` + message.substring(end)
            } else {
              newText = message.substring(0, start) + `[link](${url})` + message.substring(end)
            }
            setMessage(newText)
          }
          break
      }
    }
  }, [message, showToolbar, handleSend, onCancel])

  // Insert formatting
  const insertFormatting = (wrapper: string) => {
    const textarea = textareaRef.current
    if (!textarea) return

    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selectedText = message.substring(start, end)

    const newText = selectedText
      ? message.substring(0, start) + `${wrapper}${selectedText}${wrapper}` + message.substring(end)
      : message.substring(0, start) + `${wrapper}${wrapper}` + message.substring(end)

    setMessage(newText)
    textarea.focus()

    setTimeout(() => {
      if (selectedText) {
        textarea.selectionStart = start
        textarea.selectionEnd = end + wrapper.length * 2
      } else {
        textarea.selectionStart = textarea.selectionEnd = start + wrapper.length
      }
    }, 0)
  }

  return (
    <div className={cn('rounded-lg border bg-card', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <div className="text-sm text-muted-foreground">
          Replying to{' '}
          <span className="font-medium text-foreground">
            {recipientName || recipientEmail}
          </span>
        </div>
        {onCancel && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onCancel}
            className="h-7 w-7"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Textarea */}
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || isSending}
          className={cn(
            'w-full resize-none bg-transparent px-3 py-3 text-sm',
            'focus:outline-none',
            'placeholder:text-muted-foreground',
            'disabled:cursor-not-allowed disabled:opacity-50'
          )}
          style={{
            minHeight: `${minHeight}px`,
            maxHeight: `${maxHeight}px`,
          }}
        />
      </div>

      {sendError && (
        <p role="alert" className="px-3 pb-2 text-xs text-destructive">
          {sendError}
        </p>
      )}

      {/* Toolbar & Actions */}
      <div className="flex items-center justify-between px-3 py-2 border-t bg-muted/30">
        {/* Left: Formatting toolbar */}
        {showToolbar && (
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => insertFormatting('**')}
                  disabled={disabled || isSending}
                  className="h-8 w-8"
                >
                  <Bold className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Bold (Cmd+B)</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => insertFormatting('*')}
                  disabled={disabled || isSending}
                  className="h-8 w-8"
                >
                  <Italic className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Italic (Cmd+I)</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    const url = window.prompt('Enter URL:')
                    if (url) {
                      const textarea = textareaRef.current
                      if (textarea) {
                        const start = textarea.selectionStart
                        const end = textarea.selectionEnd
                        const selectedText = message.substring(start, end) || 'link'
                        const newText = message.substring(0, start) + `[${selectedText}](${url})` + message.substring(end)
                        setMessage(newText)
                      }
                    }
                  }}
                  disabled={disabled || isSending}
                  className="h-8 w-8"
                >
                  <Link className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Insert Link (Cmd+K)</TooltipContent>
            </Tooltip>

            <div className="w-px h-4 bg-border mx-1" />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={disabled || isSending}
                  className="h-8 w-8"
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Attach file (coming soon)</TooltipContent>
            </Tooltip>
          </div>
        )}

        {!showToolbar && <div />}

        {/* Right: Actions */}
        <div className="flex items-center gap-2">
          <div className="text-xs text-muted-foreground hidden sm:block">
            <kbd className="px-1.5 py-0.5 rounded bg-muted border text-[10px]">
              {typeof navigator !== 'undefined' && navigator.platform?.includes('Mac') ? 'Cmd' : 'Ctrl'}+Enter
            </kbd>
            {' '}to send
          </div>

          {/* More options */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={disabled || isSending}
                className="h-8 w-8"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onSaveDraft && (
                <DropdownMenuItem onClick={() => onSaveDraft(message)}>
                  <Save className="h-4 w-4 mr-2" />
                  Save draft
                </DropdownMenuItem>
              )}
              <DropdownMenuItem disabled>
                <Clock className="h-4 w-4 mr-2" />
                Schedule send (coming soon)
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setMessage('')}
                className="text-destructive"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Discard
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Send button */}
          <Button
            onClick={handleSend}
            disabled={!message.trim() || isSending || disabled}
            size="sm"
            className="gap-2"
          >
            {isSending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Send className="h-4 w-4" />
                Send
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

interface QuickReplyComposerProps {
  onExpand: () => void
  placeholder?: string
  className?: string
}

/**
 * QuickReplyComposer - Collapsed reply input that expands to full composer
 */
export function QuickReplyComposer({
  onExpand,
  placeholder = 'Write a reply...',
  className,
}: QuickReplyComposerProps) {
  return (
    <button
      onClick={onExpand}
      className={cn(
        'w-full flex items-center gap-3 px-4 py-3 rounded-lg border',
        'text-sm text-muted-foreground',
        'bg-muted/30 hover:bg-muted/50 transition-colors',
        'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
        className
      )}
    >
      <Send className="h-4 w-4" />
      <span>{placeholder}</span>
    </button>
  )
}
