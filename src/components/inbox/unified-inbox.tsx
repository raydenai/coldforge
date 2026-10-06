'use client'

import { useCallback, useEffect, useState, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { Mail } from 'lucide-react'
import {
  InboxSidebar,
  type InboxFilter,
  type InboxStats,
  type EmailAccount,
} from './inbox-sidebar'
import {
  MessageList,
  MessageListSkeleton,
  type ThreadListItem,
} from './message-list'
import {
  MessageDetail,
  MessageDetailSkeleton,
  type ThreadDetail,
  type ThreadMessage,
  type LeadInfo,
  type CampaignInfo,
  type ThreadNavigation,
} from './message-detail'
import type { ReplyCategory } from '@/lib/replies'

// API response types
interface ThreadResponse {
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
  sentiment: 'positive' | 'neutral' | 'negative'
  assignedTo: string | null
  createdAt: string
  updatedAt: string
  preview: string
  hasUnread: boolean
  isStarred?: boolean
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

interface ThreadDetailResponse {
  thread: ThreadResponse
  lead: LeadInfo | null
  campaign: CampaignInfo | null
  mailbox: { id: string; email: string; firstName: string | null; lastName: string | null } | null
  replyReadiness: { ready: boolean; reason?: string | null; sourceReplyId?: string; controlRevision?: number; control?: {revision:number;mode:string} }
  timeline: ThreadMessage[]
  navigation: ThreadNavigation
}

interface InboxApiStats {
  total: number
  unread: number
  interested: number
  notInterested: number
  outOfOffice: number
  meetingRequest: number
  unsubscribe: number
  question: number
}

interface UnifiedInboxProps {
  className?: string
}

/**
 * UnifiedInbox - Main inbox component with three-column layout
 */
export function UnifiedInbox({ className }: UnifiedInboxProps) {
  const threadRequest = useRef(0)
  const activeThreadId = useRef<string | null>(null)
  const router = useRouter()
  const searchParams = useSearchParams()

  // State
  const [threads, setThreads] = useState<ThreadListItem[]>([])
  const [selectedThread, setSelectedThread] = useState<ThreadDetailResponse | null>(null)
  const [stats, setStats] = useState<InboxStats | null>(null)
  const [accounts] = useState<EmailAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingThread, setLoadingThread] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Filters
  const [activeFilter, setActiveFilter] = useState<InboxFilter>('all')
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  // UI state
  const [showLeadInfo, setShowLeadInfo] = useState(true)

  // Transform API response to component format
  const transformThread = useCallback((thread: ThreadResponse): ThreadListItem => ({
    id: thread.id,
    subject: thread.subject,
    preview: thread.preview,
    participantEmail: thread.participantEmail,
    participantName: thread.participantName,
    lastMessageAt: thread.lastMessageAt,
    messageCount: thread.messageCount,
    hasUnread: thread.hasUnread,
    isStarred: thread.isStarred,
    category: thread.category,
    campaign: thread.campaign,
  }), [])

  // Fetch threads
  const fetchThreads = useCallback(async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams()

      if (searchQuery) params.set('search', searchQuery)
      if (activeFilter !== 'all' && !['unread', 'starred', 'archived'].includes(activeFilter)) {
        params.set('category', activeFilter)
      }
      if (activeFilter === 'unread') params.set('unreadOnly', 'true')
      if (selectedAccountId) params.set('mailboxId', selectedAccountId)

      const response = await fetch(`/api/inbox?${params.toString()}`)
      const data = await response.json()

      if (data.error) throw new Error(data.error)

      // Transform threads
      const transformedThreads = (data.threads || []).map(transformThread)
      setThreads(transformedThreads)

      // Transform stats
      const apiStats: InboxApiStats = data.stats || {}
      setStats({
        total: apiStats.total || 0,
        unread: apiStats.unread || 0,
        starred: 0, // Not tracked in current API
        archived: 0, // Not tracked in current API
        interested: apiStats.interested || 0,
        notInterested: apiStats.notInterested || 0,
        outOfOffice: apiStats.outOfOffice || 0,
        meetingRequest: apiStats.meetingRequest || 0,
        question: apiStats.question || 0,
        unsubscribe: apiStats.unsubscribe || 0,
      })
    } catch (error) {
      console.error('Failed to fetch threads:', error)
      toast.error('Failed to load inbox')
    } finally {
      setLoading(false)
    }
  }, [searchQuery, activeFilter, selectedAccountId, transformThread])

  // Fetch thread detail
  const fetchThread = useCallback(async (threadId: string) => {
    const requestVersion = ++threadRequest.current
    activeThreadId.current = threadId
    try {
      setLoadingThread(true)
      const response = await fetch(`/api/inbox/${threadId}`)
      const data: ThreadDetailResponse = await response.json()

      if ('error' in data) throw new Error((data as { error: string }).error)

      if(requestVersion !== threadRequest.current) return
      setSelectedThread(data)

      // Mark as read in local state
      setThreads((prev) =>
        prev.map((t) => (t.id === threadId ? { ...t, hasUnread: false } : t))
      )
    } catch (error) {
      if(requestVersion !== threadRequest.current) return
      console.error('Failed to fetch thread:', error)
      toast.error('Failed to load conversation')
    } finally {
      if(requestVersion === threadRequest.current) setLoadingThread(false)
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

  // Open thread
  const openThread = useCallback((thread: ThreadListItem) => {
    fetchThread(thread.id)
    router.push(`/inbox?thread=${thread.id}`, { scroll: false })
  }, [fetchThread,router])

  // Close thread
  const closeThread = useCallback(() => {
    activeThreadId.current=null;threadRequest.current++;setSelectedThread(null)
    router.push('/inbox', { scroll: false })
  }, [router])

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if typing in input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        if (e.key === 'Escape' && selectedThread) {
          e.preventDefault()
          closeThread()
        }
        return
      }

      const currentIndex = selectedThread
        ? threads.findIndex((t) => t.id === selectedThread.thread.id)
        : -1

      switch (e.key) {
        case 'j': // Next
          e.preventDefault()
          if (currentIndex < threads.length - 1) {
            const nextThread = threads[currentIndex + 1]
            if (nextThread) {
              openThread(nextThread)
            }
          }
          break
        case 'k': // Previous
          e.preventDefault()
          if (currentIndex > 0) {
            const prevThread = threads[currentIndex - 1]
            if (prevThread) {
              openThread(prevThread)
            }
          }
          break
        case 'Escape':
          e.preventDefault()
          closeThread()
          break
        case '?': // Help
          e.preventDefault()
          toast.info('Keyboard shortcuts', {
            description:
              'j/k: Navigate | e: Archive | u: Mark unread | Esc: Close | ?: Help',
            duration: 5000,
          })
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [threads, selectedThread,closeThread,openThread])

  // Navigate threads
  const handleNavigate = (direction: 'prev' | 'next') => {
    if (!selectedThread) return

    const targetId =
      direction === 'prev'
        ? selectedThread.navigation.prev
        : selectedThread.navigation.next

    if (targetId) {
      fetchThread(targetId)
      router.push(`/inbox?thread=${targetId}`, { scroll: false })
    }
  }

  // Toggle thread selection
  const toggleSelect = (threadId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(threadId)) {
        next.delete(threadId)
      } else {
        next.add(threadId)
      }
      return next
    })
  }

  // Archive thread
  const handleArchive = async () => {
    if (!selectedThread) return

    try {
      const response = await fetch('/api/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'archive',
          threadIds: [selectedThread.thread.id],
        }),
      })

      if (!response.ok) throw new Error('Failed to archive')

      toast.success('Archived')
      fetchThreads()

      // Navigate to next thread or close
      if (selectedThread.navigation.next) {
        handleNavigate('next')
      } else if (selectedThread.navigation.prev) {
        handleNavigate('prev')
      } else {
        closeThread()
      }
    } catch (error) {
      console.error('Archive failed:', error)
      toast.error('Failed to archive')
    }
  }

  // Star thread
  const handleStar = async () => {
    if (!selectedThread) return
    // TODO: Implement star toggle
    toast.info('Star feature coming soon')
  }

  // Mark unread
  const handleMarkUnread = async () => {
    if (!selectedThread) return

    try {
      const response = await fetch('/api/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'mark_unread',
          threadIds: [selectedThread.thread.id],
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
  const handleCategoryChange = async (category: ReplyCategory) => {
    if (!selectedThread) return

    try {
      const response = await fetch(`/api/inbox/${selectedThread.thread.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category }),
      })

      if (!response.ok) throw new Error('Failed to update')

      toast.success(`Marked as ${category.replace('_', ' ')}`)

      // Update local state
      setSelectedThread((prev) =>
        prev
          ? {
              ...prev,
              thread: { ...prev.thread, category },
            }
          : null
      )

      setThreads((prev) =>
        prev.map((t) =>
          t.id === selectedThread.thread.id ? { ...t, category } : t
        )
      )
    } catch (error) {
      console.error('Update category failed:', error)
      toast.error('Failed to update')
    }
  }

  // Send reply
  const handleReply = async (message: string) => {
    if (!selectedThread) return

    let definiteRejection = false
    let heldResponse = false
    try {
      const response = await fetch(
        `/api/inbox/${selectedThread.thread.id}/reply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message,sourceReplyId:selectedThread.replyReadiness.sourceReplyId,controlRevision:selectedThread.replyReadiness.controlRevision }),
        }
      )

      if (!response.ok) {
        definiteRejection = [400,401,403,409,503].includes(response.status)
        const payload = await response.json().catch(() => null)
        const detail = payload?.error?.message ?? payload?.error
        throw new Error(typeof detail === 'string' ? detail : 'Failed to send')
      }

      const result = await response.json()
      if(!result.accepted) {
        heldResponse = true
        const reason=`Reply held; do not resend. Reference ${result.attemptId ?? 'unavailable'}. ${result.code ?? result.receipt?.code ?? result.settlement?.status ?? 'unknown outcome'}`
        if(activeThreadId.current===selectedThread.thread.id) setSelectedThread(current=>current?.thread.id===selectedThread.thread.id?{...current,replyReadiness:{...current.replyReadiness,ready:false,reason}}:current)
        throw new Error(reason)
      }
      toast.success('SMTP accepted the reply; delivery is not yet confirmed')
      if(activeThreadId.current === selectedThread.thread.id) fetchThread(selectedThread.thread.id)
    } catch (error) {
      if(!definiteRejection && !heldResponse) {
        const reason=`Reply response uncertain; do not resend until server reconciliation. Reference ${selectedThread.thread.id}/${selectedThread.replyReadiness.sourceReplyId ?? 'unknown inbound'}.`
        if(activeThreadId.current===selectedThread.thread.id) setSelectedThread(current=>current?.thread.id===selectedThread.thread.id?{...current,replyReadiness:{...current.replyReadiness,ready:false,reason}}:current)
        throw new Error(reason)
      }
      console.error('Send reply failed:', error)
      throw error // Re-throw to let composer handle it
    }
  }

  // Convert thread for MessageDetail
  const getThreadDetail = (): ThreadDetail | null => {
    if (!selectedThread) return null
    return {
      id: selectedThread.thread.id,
      subject: selectedThread.thread.subject,
      participantEmail: selectedThread.thread.participantEmail,
      participantName: selectedThread.thread.participantName,
      category: selectedThread.thread.category,
      sentiment: selectedThread.thread.sentiment,
      status: selectedThread.thread.status,
      isStarred: selectedThread.thread.isStarred,
      messageCount: selectedThread.thread.messageCount,
    }
  }

  return (
    <div className={cn('flex h-[calc(100vh-4rem)] overflow-hidden', className)}>
      {/* Left Sidebar - Filters */}
      <div className="hidden md:block w-64 shrink-0">
        <InboxSidebar
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
          stats={stats}
          accounts={accounts}
          selectedAccountId={selectedAccountId}
          onAccountSelect={setSelectedAccountId}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onRefresh={fetchThreads}
          isLoading={loading}
        />
      </div>

      {/* Middle - Message List */}
      <div
        className={cn(
          'flex flex-col border-r bg-background',
          selectedThread
            ? 'hidden md:flex md:w-[350px] lg:w-[400px]'
            : 'flex-1'
        )}
      >
        {loading ? (
          <MessageListSkeleton />
        ) : (
          <MessageList
            threads={threads}
            selectedThreadId={selectedThread?.thread.id}
            selectedIds={selectedIds}
            onThreadSelect={openThread}
            onToggleSelect={toggleSelect}
          />
        )}
      </div>

      {/* Right - Message Detail */}
      {selectedThread ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          {loadingThread ? (
            <MessageDetailSkeleton />
          ) : (
            <MessageDetail
              key={selectedThread.thread.id}
              thread={getThreadDetail()!}
              messages={selectedThread.timeline}
              lead={selectedThread.lead}
              campaign={selectedThread.campaign}
              navigation={selectedThread.navigation}
              onNavigate={handleNavigate}
              onClose={closeThread}
              onArchive={handleArchive}
              onStar={handleStar}
              onMarkUnread={handleMarkUnread}
              onCategoryChange={handleCategoryChange}
              onReply={handleReply}
              isLoading={loadingThread}
              showLeadInfo={showLeadInfo}
              onToggleLeadInfo={() => setShowLeadInfo(!showLeadInfo)}
              replyTransportAvailable={selectedThread.replyReadiness?.ready ?? false}
              replyDisabledReason={selectedThread.replyReadiness?.reason ?? 'Reply setup required'}
              onTakeover={async()=>{try{const id=selectedThread.thread.id;const response=await fetch(`/api/inbox/${id}/control`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'human',expectedRevision:selectedThread.replyReadiness.control?.revision})});const result=await response.json();if(!response.ok||!result.allowed){toast.error(result.reason??result.error?.message??'Takeover failed');return}if(activeThreadId.current===id)fetchThread(id)}catch{toast.error('Takeover failed; reload the conversation before trying again')}}}
            />
          )}
        </div>
      ) : (
        // Empty state when no thread selected (only on desktop)
        <div className="hidden md:flex flex-1 items-center justify-center bg-muted/10">
          <div className="text-center">
            <div className="mx-auto rounded-full bg-muted p-4 w-fit">
              <Mail className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="mt-4 font-medium">Select a conversation</h3>
            <p className="mt-1 text-sm text-muted-foreground max-w-sm">
              Choose a conversation from the list to view it here
            </p>
            <div className="mt-4 text-xs text-muted-foreground">
              <kbd className="px-1.5 py-0.5 rounded bg-muted border">j</kbd>/
              <kbd className="px-1.5 py-0.5 rounded bg-muted border">k</kbd> to
              navigate,{' '}
              <kbd className="px-1.5 py-0.5 rounded bg-muted border">?</kbd> for
              help
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
