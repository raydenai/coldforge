'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Clock,
  ExternalLink,
  Inbox,
  Loader2,
  Mail,
  MailOpen,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  Reply,
  Search,
  Send,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  User,
  X,
  Building2,
  Briefcase,
  Phone,
  Linkedin,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { MessageBody } from '@/components/inbox/message-body'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from 'sonner'
import type { ReplyCategory, ReplySentiment } from '@/lib/replies'

// Types
interface Thread {
  id: string
  organizationId: string
  campaignId: string | null
  leadId: string | null
  mailboxId: string
  subject: string
  participantEmail: string
  participantName: string | null
  messageCount: number
  lastMessageAt: string
  status: 'active' | 'resolved' | 'archived'
  category: ReplyCategory
  sentiment: ReplySentiment
  assignedTo: string | null
  createdAt: string
  updatedAt: string
  preview: string
  hasUnread: boolean
  lead: {
    id: string
    email: string
    firstName: string | null
    lastName: string | null
    company: string | null
    title: string | null
  } | null
  campaign: {
    id: string
    name: string
  } | null
}

interface ThreadDetail {
  thread: Thread
  lead: {
    id: string
    email: string
    firstName: string | null
    lastName: string | null
    company: string | null
    title: string | null
    phone: string | null
    linkedinUrl: string | null
    status: string
    customFields: Record<string, unknown>
  } | null
  campaign: {
    id: string
    name: string
    status: string
  } | null
  mailbox: {
    id: string
    email: string
    firstName: string | null
    lastName: string | null
  } | null
  timeline: Array<{
    id: string
    type: 'message' | 'reply'
    direction: 'inbound' | 'outbound'
    messageId: string
    from: string
    fromName: string | null
    to: string
    subject: string
    bodyText: string
    bodyHtml: string | null
    timestamp: string
    category: ReplyCategory | null
    sentiment: ReplySentiment | null
    status: string | null
    isAutoDetected: boolean
  }>
  navigation: {
    prev: string | null
    next: string | null
    currentIndex: number
    total: number
  }
}

interface InboxStats {
  total: number
  unread: number
  interested: number
  notInterested: number
  outOfOffice: number
  meetingRequest: number
  unsubscribe: number
  question: number
}

// Category config
const categoryConfig: Record<ReplyCategory, { label: string; color: string; icon: React.ReactNode }> = {
  interested: { label: 'Interested', color: 'bg-green-500/10 text-green-600 border-green-200', icon: <ThumbsUp className="h-3 w-3" /> },
  not_interested: { label: 'Not Interested', color: 'bg-red-500/10 text-red-600 border-red-200', icon: <ThumbsDown className="h-3 w-3" /> },
  out_of_office: { label: 'Out of Office', color: 'bg-yellow-500/10 text-yellow-600 border-yellow-200', icon: <Clock className="h-3 w-3" /> },
  unsubscribe: { label: 'Unsubscribe', color: 'bg-gray-500/10 text-gray-600 border-gray-200', icon: <X className="h-3 w-3" /> },
  meeting_request: { label: 'Meeting', color: 'bg-blue-500/10 text-blue-600 border-blue-200', icon: <MessageSquare className="h-3 w-3" /> },
  question: { label: 'Question', color: 'bg-purple-500/10 text-purple-600 border-purple-200', icon: <MessageSquare className="h-3 w-3" /> },
  referral: { label: 'Referral', color: 'bg-cyan-500/10 text-cyan-600 border-cyan-200', icon: <User className="h-3 w-3" /> },
  bounce: { label: 'Bounce', color: 'bg-orange-500/10 text-orange-600 border-orange-200', icon: <X className="h-3 w-3" /> },
  auto_reply: { label: 'Auto Reply', color: 'bg-gray-500/10 text-gray-600 border-gray-200', icon: <Mail className="h-3 w-3" /> },
  other: { label: 'Other', color: 'bg-gray-500/10 text-gray-600 border-gray-200', icon: <Mail className="h-3 w-3" /> },
}

// Category filter tabs
type CategoryFilter = 'all' | ReplyCategory

export default function InboxContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  // State
  const [threads, setThreads] = useState<Thread[]>([])
  const [selectedThread, setSelectedThread] = useState<ThreadDetail | null>(null)
  const [stats, setStats] = useState<InboxStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingThread, setLoadingThread] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const [showReplyComposer, setShowReplyComposer] = useState(false)
  const [replyMessage, setReplyMessage] = useState('')
  const [sendingReply, setSendingReply] = useState(false)
  const [showLeadInfo, setShowLeadInfo] = useState(true)

  // Refs for keyboard navigation
  const listRef = useRef<HTMLDivElement>(null)
  const replyTextareaRef = useRef<HTMLTextAreaElement>(null)

  // Fetch threads
  const fetchThreads = useCallback(async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      if (categoryFilter !== 'all') params.set('category', categoryFilter)

      const response = await fetch(`/api/inbox?${params.toString()}`)
      const data = await response.json()

      if (data.error) throw new Error(data.error)

      setThreads(data.threads || [])
      setStats(data.stats || null)
    } catch (error) {
      console.error('Failed to fetch threads:', error)
      toast.error('Failed to load inbox')
    } finally {
      setLoading(false)
    }
  }, [search, categoryFilter])

  // Fetch thread details
  const fetchThread = useCallback(async (threadId: string) => {
    try {
      setLoadingThread(true)
      const response = await fetch(`/api/inbox/${threadId}`)
      const data = await response.json()

      if (data.error) throw new Error(data.error)

      setSelectedThread(data)
      setShowReplyComposer(false)
      setReplyMessage('')

      // Mark as read in local state
      setThreads(prev => prev.map(t =>
        t.id === threadId ? { ...t, hasUnread: false } : t
      ))
    } catch (error) {
      console.error('Failed to fetch thread:', error)
      toast.error('Failed to load conversation')
    } finally {
      setLoadingThread(false)
    }
  }, [])

  // Initial fetch
  useEffect(() => {
    fetchThreads()
  }, [fetchThreads])

  // Handle URL thread param
  useEffect(() => {
    const threadId = searchParams.get('thread')
    if (threadId && threads.length > 0) {
      fetchThread(threadId)
    }
  }, [searchParams, threads.length, fetchThread])

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if typing in input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        // Allow Escape in composer
        if (e.key === 'Escape' && showReplyComposer) {
          e.preventDefault()
          setShowReplyComposer(false)
        }
        // Allow Cmd+Enter to send
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && showReplyComposer) {
          e.preventDefault()
          handleSendReply()
        }
        return
      }

      const currentIndex = selectedThread
        ? threads.findIndex(t => t.id === selectedThread.thread.id)
        : -1

      switch (e.key) {
        case 'j': // Next
          e.preventDefault()
          if (currentIndex < threads.length - 1) {
            const nextThread = threads[currentIndex + 1]
            if (nextThread) {
              fetchThread(nextThread.id)
              router.push(`/inbox?thread=${nextThread.id}`, { scroll: false })
            }
          }
          break
        case 'k': // Previous
          e.preventDefault()
          if (currentIndex > 0) {
            const prevThread = threads[currentIndex - 1]
            if (prevThread) {
              fetchThread(prevThread.id)
              router.push(`/inbox?thread=${prevThread.id}`, { scroll: false })
            }
          }
          break
        case 'r': // Reply
          e.preventDefault()
          if (selectedThread) {
            setShowReplyComposer(true)
            setTimeout(() => replyTextareaRef.current?.focus(), 100)
          }
          break
        case 'e': // Archive
          e.preventDefault()
          if (selectedThread) {
            handleArchive([selectedThread.thread.id])
          }
          break
        case 'u': // Mark unread
          e.preventDefault()
          if (selectedThread) {
            handleMarkUnread([selectedThread.thread.id])
          }
          break
        case 'Escape':
          e.preventDefault()
          if (showReplyComposer) {
            setShowReplyComposer(false)
          } else if (selectedThread) {
            setSelectedThread(null)
            router.push('/inbox', { scroll: false })
          }
          break
        case 'x': // Toggle selection
          e.preventDefault()
          if (selectedThread) {
            toggleSelect(selectedThread.thread.id)
          }
          break
        case '?': // Help
          e.preventDefault()
          toast.info('Keyboard shortcuts', {
            description: 'j/k: Navigate | r: Reply | e: Archive | u: Mark unread | x: Select | ?: Help',
            duration: 5000,
          })
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [threads, selectedThread, showReplyComposer, router, fetchThread])

  // Toggle thread selection
  const toggleSelect = (threadId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(threadId)) {
        next.delete(threadId)
      } else {
        next.add(threadId)
      }
      return next
    })
  }

  // Select all visible
  const selectAll = () => {
    setSelectedIds(new Set(threads.map(t => t.id)))
  }
  void selectAll // Suppress unused warning - function may be used in future

  // Clear selection
  const clearSelection = () => {
    setSelectedIds(new Set())
  }

  // Bulk actions
  const handleBulkAction = async (action: 'mark_read' | 'mark_unread' | 'archive') => {
    if (selectedIds.size === 0) return

    try {
      const response = await fetch('/api/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          threadIds: Array.from(selectedIds),
        }),
      })

      if (!response.ok) throw new Error('Failed to perform action')

      toast.success(`${selectedIds.size} conversations updated`)
      clearSelection()
      fetchThreads()

      if (action === 'archive' && selectedThread && selectedIds.has(selectedThread.thread.id)) {
        setSelectedThread(null)
        router.push('/inbox', { scroll: false })
      }
    } catch (error) {
      console.error('Bulk action failed:', error)
      toast.error('Action failed')
    }
  }

  // Archive threads
  const handleArchive = async (threadIds: string[]) => {
    try {
      const response = await fetch('/api/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'archive',
          threadIds,
        }),
      })

      if (!response.ok) throw new Error('Failed to archive')

      toast.success('Archived')
      fetchThreads()

      if (selectedThread && threadIds.includes(selectedThread.thread.id)) {
        // Navigate to next thread if available
        const currentIndex = threads.findIndex(t => t.id === selectedThread.thread.id)
        const nextThread = threads[currentIndex + 1] || threads[currentIndex - 1]
        if (nextThread) {
          fetchThread(nextThread.id)
          router.push(`/inbox?thread=${nextThread.id}`, { scroll: false })
        } else {
          setSelectedThread(null)
          router.push('/inbox', { scroll: false })
        }
      }
    } catch (error) {
      console.error('Archive failed:', error)
      toast.error('Failed to archive')
    }
  }

  // Mark unread
  const handleMarkUnread = async (threadIds: string[]) => {
    try {
      const response = await fetch('/api/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'mark_unread',
          threadIds,
        }),
      })

      if (!response.ok) throw new Error('Failed to mark unread')

      toast.success('Marked as unread')
      fetchThreads()
    } catch (error) {
      console.error('Mark unread failed:', error)
      toast.error('Failed to mark unread')
    }
  }

  // Update category
  const handleUpdateCategory = async (category: ReplyCategory) => {
    if (!selectedThread) return

    try {
      const response = await fetch(`/api/inbox/${selectedThread.thread.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category }),
      })

      if (!response.ok) throw new Error('Failed to update')

      toast.success(`Marked as ${categoryConfig[category].label}`)

      // Update local state
      setSelectedThread(prev => prev ? {
        ...prev,
        thread: { ...prev.thread, category }
      } : null)

      setThreads(prev => prev.map(t =>
        t.id === selectedThread.thread.id ? { ...t, category } : t
      ))
    } catch (error) {
      console.error('Update category failed:', error)
      toast.error('Failed to update')
    }
  }

  // Send reply
  const handleSendReply = async () => {
    if (!selectedThread || !replyMessage.trim()) return

    try {
      setSendingReply(true)
      const response = await fetch(`/api/inbox/${selectedThread.thread.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: replyMessage,
        }),
      })

      if (!response.ok) throw new Error('Failed to send')

      toast.success('Reply sent')
      setShowReplyComposer(false)
      setReplyMessage('')

      // Refresh thread
      fetchThread(selectedThread.thread.id)
    } catch (error) {
      console.error('Send reply failed:', error)
      toast.error('Failed to send reply')
    } finally {
      setSendingReply(false)
    }
  }

  // Open thread
  const openThread = (thread: Thread) => {
    fetchThread(thread.id)
    router.push(`/inbox?thread=${thread.id}`, { scroll: false })
  }

  // Format date
  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`

    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(date.getFullYear() !== now.getFullYear() && { year: 'numeric' }),
    })
  }

  // Get initials
  const getInitials = (name: string | null, email: string) => {
    if (name) {
      return name.split(' ').map(n => n?.[0]).join('').toUpperCase().slice(0, 2)
    }
    return email?.[0]?.toUpperCase() || '?'
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      {/* Left Panel - Thread List */}
      <div className={cn(
        "flex flex-col border-r bg-background",
        selectedThread ? "hidden md:flex md:w-[400px] lg:w-[450px]" : "flex-1"
      )}>
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <Inbox className="h-5 w-5" />
            <h1 className="font-semibold">Inbox</h1>
            {stats?.unread ? (
              <Badge variant="secondary" className="ml-1">{stats.unread}</Badge>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => fetchThreads()}>
                  <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Search */}
        <div className="border-b px-3 py-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search conversations..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>

        {/* Category Tabs */}
        <div className="border-b px-2 py-2 overflow-x-auto">
          <Tabs value={categoryFilter} onValueChange={(v) => setCategoryFilter(v as CategoryFilter)}>
            <TabsList className="h-8">
              <TabsTrigger value="all" className="text-xs px-3 h-7">
                All {stats?.total ? `(${stats.total})` : ''}
              </TabsTrigger>
              <TabsTrigger value="interested" className="text-xs px-3 h-7">
                <ThumbsUp className="h-3 w-3 mr-1" />
                Interested {stats?.interested ? `(${stats.interested})` : ''}
              </TabsTrigger>
              <TabsTrigger value="not_interested" className="text-xs px-3 h-7">
                <ThumbsDown className="h-3 w-3 mr-1" />
                Not Interested
              </TabsTrigger>
              <TabsTrigger value="out_of_office" className="text-xs px-3 h-7">
                <Clock className="h-3 w-3 mr-1" />
                OOO
              </TabsTrigger>
              <TabsTrigger value="unsubscribe" className="text-xs px-3 h-7">
                Unsubscribe
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* Bulk Actions */}
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-2 border-b px-3 py-2 bg-muted/50">
            <span className="text-sm text-muted-foreground">
              {selectedIds.size} selected
            </span>
            <Button variant="ghost" size="sm" onClick={() => handleBulkAction('mark_read')}>
              <MailOpen className="h-4 w-4 mr-1" />
              Read
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handleBulkAction('archive')}>
              <Archive className="h-4 w-4 mr-1" />
              Archive
            </Button>
            <Button variant="ghost" size="sm" onClick={clearSelection}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}

        {/* Thread List */}
        <div ref={listRef} className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : threads.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Inbox className="h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 font-medium">No conversations</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Replies from your campaigns will appear here
              </p>
            </div>
          ) : (
            threads.map((thread) => (
              <div
                key={thread.id}
                onClick={() => openThread(thread)}
                className={cn(
                  "flex cursor-pointer border-b p-3 hover:bg-muted/50 transition-colors",
                  selectedThread?.thread.id === thread.id && "bg-muted",
                  thread.hasUnread && "bg-blue-50/50 dark:bg-blue-950/20"
                )}
              >
                {/* Selection checkbox */}
                <div
                  className="mr-3 flex items-start pt-1"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleSelect(thread.id)
                  }}
                >
                  <div className={cn(
                    "h-4 w-4 rounded border flex items-center justify-center",
                    selectedIds.has(thread.id)
                      ? "bg-primary border-primary text-primary-foreground"
                      : "border-muted-foreground/30"
                  )}>
                    {selectedIds.has(thread.id) && <Check className="h-3 w-3" />}
                  </div>
                </div>

                {/* Avatar */}
                <Avatar className="h-10 w-10 shrink-0">
                  <AvatarFallback className={cn(
                    thread.hasUnread && "font-semibold"
                  )}>
                    {getInitials(thread.participantName, thread.participantEmail)}
                  </AvatarFallback>
                </Avatar>

                {/* Content */}
                <div className="ml-3 min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className={cn(
                      "truncate text-sm",
                      thread.hasUnread && "font-semibold"
                    )}>
                      {thread.participantName || thread.participantEmail}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatDate(thread.lastMessageAt)}
                    </span>
                  </div>
                  <div className={cn(
                    "truncate text-sm",
                    thread.hasUnread ? "font-medium" : "text-muted-foreground"
                  )}>
                    {thread.subject}
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={cn("text-[10px] px-1.5 py-0", categoryConfig[thread.category]?.color)}
                    >
                      {categoryConfig[thread.category]?.icon}
                      <span className="ml-1">{categoryConfig[thread.category]?.label}</span>
                      <span title="AI categorized"><Sparkles className="ml-1 h-2.5 w-2.5" /></span>
                    </Badge>
                    {thread.campaign && (
                      <span className="truncate text-[10px] text-muted-foreground">
                        {thread.campaign.name}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {thread.preview}
                  </p>
                </div>

                {/* Unread indicator */}
                {thread.hasUnread && (
                  <div className="ml-2 flex items-start pt-2">
                    <div className="h-2 w-2 rounded-full bg-blue-500" />
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right Panel - Thread View */}
      {selectedThread ? (
        <div className="flex flex-1 flex-col">
          {/* Thread Header */}
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                onClick={() => {
                  setSelectedThread(null)
                  router.push('/inbox', { scroll: false })
                }}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <div>
                <h2 className="font-semibold">{selectedThread.thread.subject}</h2>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>{selectedThread.thread.participantEmail}</span>
                  {selectedThread.thread.messageCount > 1 && (
                    <span>({selectedThread.thread.messageCount} messages)</span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1">
              {/* Navigation */}
              <div className="flex items-center gap-1 text-sm text-muted-foreground mr-2">
                <span>{selectedThread.navigation.currentIndex} of {selectedThread.navigation.total}</span>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={!selectedThread.navigation.prev}
                    onClick={() => {
                      if (selectedThread.navigation.prev) {
                        fetchThread(selectedThread.navigation.prev)
                        router.push(`/inbox?thread=${selectedThread.navigation.prev}`, { scroll: false })
                      }
                    }}
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Previous (k)</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={!selectedThread.navigation.next}
                    onClick={() => {
                      if (selectedThread.navigation.next) {
                        fetchThread(selectedThread.navigation.next)
                        router.push(`/inbox?thread=${selectedThread.navigation.next}`, { scroll: false })
                      }
                    }}
                  >
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Next (j)</TooltipContent>
              </Tooltip>

              <Separator orientation="vertical" className="h-6 mx-2" />

              {/* Actions */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleArchive([selectedThread.thread.id])}
                  >
                    <Archive className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Archive (e)</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleMarkUnread([selectedThread.thread.id])}
                  >
                    <Mail className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Mark unread (u)</TooltipContent>
              </Tooltip>

              {/* Category dropdown */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm">
                    <Badge
                      variant="outline"
                      className={cn("text-xs", categoryConfig[selectedThread.thread.category]?.color)}
                    >
                      {categoryConfig[selectedThread.thread.category]?.label}
                    </Badge>
                    <ChevronDown className="ml-1 h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {Object.entries(categoryConfig).map(([key, config]) => (
                    <DropdownMenuItem
                      key={key}
                      onClick={() => handleUpdateCategory(key as ReplyCategory)}
                    >
                      {config.icon}
                      <span className="ml-2">{config.label}</span>
                      {selectedThread.thread.category === key && (
                        <Check className="ml-auto h-4 w-4" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setShowLeadInfo(!showLeadInfo)}>
                    <User className="h-4 w-4 mr-2" />
                    {showLeadInfo ? 'Hide' : 'Show'} Lead Info
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive">
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Thread Content */}
          <div className="flex flex-1 overflow-hidden">
            {/* Messages */}
            <div className="flex-1 overflow-y-auto">
              {loadingThread ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="space-y-4 p-4">
                  {selectedThread.timeline.map((message) => (
                    <div
                      key={message.id}
                      className={cn(
                        "rounded-lg border p-4",
                        message.direction === 'outbound'
                          ? "bg-blue-50/50 dark:bg-blue-950/20 ml-8"
                          : "mr-8"
                      )}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                          <Avatar className="h-8 w-8">
                            <AvatarFallback className="text-xs">
                              {getInitials(message.fromName, message.from)}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <div className="font-medium text-sm">
                              {message.fromName || message.from}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              to {message.to}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {message.isAutoDetected && message.category && (
                            <Badge
                              variant="outline"
                              className={cn("text-[10px]", categoryConfig[message.category]?.color)}
                            >
                              <Sparkles className="h-2.5 w-2.5 mr-1" />
                              AI
                            </Badge>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {formatDate(message.timestamp)}
                          </span>
                        </div>
                      </div>
                      <div className="mt-3 text-sm">
                        <MessageBody bodyText={message.bodyText} bodyHtml={message.bodyHtml} />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Reply Composer */}
              <div className="border-t p-4">
                {showReplyComposer ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="text-sm text-muted-foreground">
                        Replying to {selectedThread.thread.participantEmail}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowReplyComposer(false)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                    <textarea
                      ref={replyTextareaRef}
                      value={replyMessage}
                      onChange={(e) => setReplyMessage(e.target.value)}
                      disabled
                      placeholder="Reply sending is not configured"
                      className="w-full min-h-[120px] rounded-md border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <div className="flex items-center justify-between">
                      <div className="text-xs text-muted-foreground">
                        Email sending is unavailable until the durable Winnr transport is configured.
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setShowReplyComposer(false)}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={handleSendReply}
                          disabled title="Email sending is unavailable until the durable Winnr transport is configured"
                        >
                          {sendingReply ? (
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                          ) : (
                            <Send className="h-4 w-4 mr-2" />
                          )}
                          Send
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full justify-start text-muted-foreground"
                    onClick={() => {
                      setShowReplyComposer(true)
                      setTimeout(() => replyTextareaRef.current?.focus(), 100)
                    }}
                  >
                    <Reply className="h-4 w-4 mr-2" />
                    Reply...
                  </Button>
                )}
              </div>
            </div>

            {/* Lead Info Sidebar */}
            {showLeadInfo && selectedThread.lead && (
              <div className="hidden lg:block w-72 border-l overflow-y-auto">
                <div className="p-4 space-y-4">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-12 w-12">
                      <AvatarFallback>
                        {getInitials(
                          selectedThread.lead.firstName && selectedThread.lead.lastName
                            ? `${selectedThread.lead.firstName} ${selectedThread.lead.lastName}`
                            : null,
                          selectedThread.lead.email
                        )}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <div className="font-medium">
                        {selectedThread.lead.firstName} {selectedThread.lead.lastName}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {selectedThread.lead.email}
                      </div>
                    </div>
                  </div>

                  <Separator />

                  <div className="space-y-3">
                    {selectedThread.lead.company && (
                      <div className="flex items-center gap-2 text-sm">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <span>{selectedThread.lead.company}</span>
                      </div>
                    )}
                    {selectedThread.lead.title && (
                      <div className="flex items-center gap-2 text-sm">
                        <Briefcase className="h-4 w-4 text-muted-foreground" />
                        <span>{selectedThread.lead.title}</span>
                      </div>
                    )}
                    {selectedThread.lead.phone && (
                      <div className="flex items-center gap-2 text-sm">
                        <Phone className="h-4 w-4 text-muted-foreground" />
                        <span>{selectedThread.lead.phone}</span>
                      </div>
                    )}
                    {selectedThread.lead.linkedinUrl && (
                      <a
                        href={selectedThread.lead.linkedinUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 text-sm text-blue-600 hover:underline"
                      >
                        <Linkedin className="h-4 w-4" />
                        <span>LinkedIn Profile</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>

                  <Separator />

                  {selectedThread.campaign && (
                    <div className="space-y-2">
                      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        Campaign
                      </div>
                      <div className="text-sm">{selectedThread.campaign.name}</div>
                      <Badge variant="outline" className="text-xs">
                        {selectedThread.campaign.status}
                      </Badge>
                    </div>
                  )}

                  <Separator />

                  <div className="space-y-2">
                    <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Lead Status
                    </div>
                    <Badge variant="outline">
                      {selectedThread.lead.status}
                    </Badge>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        // Empty state when no thread selected (only on desktop)
        <div className="hidden md:flex flex-1 items-center justify-center bg-muted/10">
          <div className="text-center">
            <Mail className="h-12 w-12 mx-auto text-muted-foreground/50" />
            <h3 className="mt-4 font-medium">Select a conversation</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose a conversation from the list to view it here
            </p>
            <div className="mt-4 text-xs text-muted-foreground">
              <kbd className="px-1 rounded bg-muted">j</kbd>/<kbd className="px-1 rounded bg-muted">k</kbd> to navigate,
              {' '}<kbd className="px-1 rounded bg-muted">?</kbd> for help
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
