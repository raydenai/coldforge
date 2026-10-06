'use client'

import { useCallback, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
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
import {
  ArrowLeft,
  ArrowRight,
  Archive,
  Star,
  Mail,
  Trash2,
  MoreHorizontal,
  User,
  Building2,
  Briefcase,
  Phone,
  Linkedin,
  ExternalLink,
  Loader2,
  Sparkles,
  Forward,
  Copy,
  Flag,
  Tag,
} from 'lucide-react'
import { CategoryBadgeDropdown, categoryConfig } from './category-badge'
import { ReplyComposer, QuickReplyComposer } from './reply-composer'
import { MessageBody } from './message-body'
import type { ReplyCategory, ReplySentiment } from '@/lib/replies'

// Thread message interface
export interface ThreadMessage {
  id: string
  type: 'message' | 'reply'
  direction: 'inbound' | 'outbound'
  messageId: string
  from: string
  fromName: string | null
  fromAvatar?: string
  to: string
  subject: string
  bodyText: string
  bodyHtml: string | null
  timestamp: string
  category: ReplyCategory | null
  sentiment: ReplySentiment | null
  status: string | null
  isAutoDetected: boolean
}

// Lead information
export interface LeadInfo {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  company: string | null
  title: string | null
  phone: string | null
  linkedinUrl: string | null
  avatar?: string
  status: string
  customFields?: Record<string, unknown>
}

// Campaign information
export interface CampaignInfo {
  id: string
  name: string
  status: string
}

// Thread detail
export interface ThreadDetail {
  id: string
  subject: string
  participantEmail: string
  participantName: string | null
  category: ReplyCategory
  sentiment: ReplySentiment
  status: 'active' | 'resolved' | 'archived'
  isStarred?: boolean
  messageCount: number
}

// Navigation
export interface ThreadNavigation {
  prev: string | null
  next: string | null
  currentIndex: number
  total: number
}

interface MessageDetailProps {
  thread: ThreadDetail
  messages: ThreadMessage[]
  lead?: LeadInfo | null
  campaign?: CampaignInfo | null
  navigation: ThreadNavigation
  onNavigate: (direction: 'prev' | 'next') => void
  onClose: () => void
  onArchive: () => void
  onStar: () => void
  onMarkUnread: () => void
  onCategoryChange: (category: ReplyCategory) => void
  onReply: (message: string) => Promise<void>
  onDelete?: () => void
  isLoading?: boolean
  showLeadInfo?: boolean
  onToggleLeadInfo?: () => void
  /** Reply sending is gated until the durable transport is integrated. */
  replyTransportAvailable?: boolean
  onTakeover?: () => Promise<void>
  replyDisabledReason?: string
  className?: string
}

/**
 * MessageDetail - Full thread view with messages and actions
 */
export function MessageDetail({
  thread,
  messages,
  lead,
  campaign,
  navigation,
  onNavigate,
  onClose,
  onArchive,
  onStar,
  onMarkUnread,
  onCategoryChange,
  onReply,
  onDelete,
  isLoading = false,
  showLeadInfo = true,
  onToggleLeadInfo,
  replyTransportAvailable = true,
  replyDisabledReason,
  onTakeover,
  className,
}: MessageDetailProps) {
  const [showReplyComposer, setShowReplyComposer] = useState(false)
  const replyDisabled = !replyTransportAvailable
  const readableReason:Record<string,string>={human_takeover_required:'Take over this conversation before sending a human reply.',inbound_body_required:'Fetch the latest incoming message body before replying.',canonical_lead_required:'Link this conversation to its current contact before replying.',approved_sender_identity_required:'Configure an approved sender identity for this conversation.',current_mailbox_ingestion_required:'Connect this mailbox and its verified inbox receiver in Winnr setup.',suppressed_or_archived:'This recipient is suppressed or this conversation is archived.',response_already_reserved:'A reply is already reserved or accepted for this incoming message. Reconcile any unknown outcome before continuing.',owner_or_admin_required:'Only an owner or admin can send replies.'}
  const displayReplyReason=replyDisabledReason?(readableReason[replyDisabledReason]??replyDisabledReason):undefined

  // Format date
  const formatDate = useCallback((dateString: string) => {
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

    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }, [])

  // Get initials
  const getInitials = useCallback((name: string | null, email: string) => {
    if (name) {
      return name
        .split(' ')
        .map((n) => n?.[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    }
    return email?.[0]?.toUpperCase() || '?'
  }, [])

  // Handle send reply
  const handleSendReply = async (message: string) => {
    await onReply(message)
    setShowReplyComposer(false)
  }

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          {/* Back button (mobile) */}
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden h-8 w-8"
            onClick={onClose}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>

          {/* Subject & meta */}
          <div className="min-w-0">
            <h2 className="font-semibold truncate">{thread.subject}</h2>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="truncate">{thread.participantEmail}</span>
              {thread.messageCount > 1 && (
                <span className="shrink-0">({thread.messageCount} messages)</span>
              )}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Navigation */}
          <div className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground mr-2">
            <span>{navigation.currentIndex} of {navigation.total}</span>
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={!navigation.prev}
                onClick={() => onNavigate('prev')}
                className="h-8 w-8"
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
                disabled={!navigation.next}
                onClick={() => onNavigate('next')}
                className="h-8 w-8"
              >
                <ArrowRight className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Next (j)</TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="h-6 mx-2" />

          {/* Archive */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onArchive}
                className="h-8 w-8"
              >
                <Archive className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Archive (e)</TooltipContent>
          </Tooltip>

          {/* Star */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onStar}
                className="h-8 w-8"
              >
                <Star className={cn(
                  'h-4 w-4',
                  thread.isStarred && 'fill-amber-400 text-amber-400'
                )} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Star</TooltipContent>
          </Tooltip>

          {/* Mark unread */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onMarkUnread}
                className="h-8 w-8"
              >
                <Mail className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Mark unread (u)</TooltipContent>
          </Tooltip>

          {/* Category dropdown */}
          <CategoryBadgeDropdown
            category={thread.category}
            onCategoryChange={onCategoryChange}
            size="sm"
          />

          {/* More options */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onToggleLeadInfo && (
                <DropdownMenuItem onClick={onToggleLeadInfo}>
                  <User className="h-4 w-4 mr-2" />
                  {showLeadInfo ? 'Hide' : 'Show'} Lead Info
                </DropdownMenuItem>
              )}
              <DropdownMenuItem>
                <Forward className="h-4 w-4 mr-2" />
                Forward
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Copy className="h-4 w-4 mr-2" />
                Copy to clipboard
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Flag className="h-4 w-4 mr-2" />
                Flag
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {onDelete && (
                <DropdownMenuItem
                  onClick={onDelete}
                  className="text-destructive"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Messages */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <ScrollArea className="flex-1">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-4 p-4">
                {messages.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    formatDate={formatDate}
                    getInitials={getInitials}
                  />
                ))}
              </div>
            )}
          </ScrollArea>

          {/* Reply Composer */}
          <div className="border-t p-4 shrink-0 space-y-2">
            {replyDisabled && onTakeover && replyDisabledReason === 'human_takeover_required' && <Button type="button" onClick={()=>void onTakeover()}>Take over conversation</Button>}
            {replyDisabled && <a href="/winnr" className="text-xs underline">Mailbox and inbox setup</a>}
            {replyDisabled && replyDisabledReason && (
              <p role="status" className="text-xs text-muted-foreground">
                {displayReplyReason}
              </p>
            )}
            {showReplyComposer ? (
              <ReplyComposer
                recipientEmail={thread.participantEmail}
                recipientName={thread.participantName}
                onSend={handleSendReply}
                showToolbar={false}
                onCancel={() => setShowReplyComposer(false)}
                disabled={replyDisabled}
                placeholder={replyDisabled ? displayReplyReason ?? 'Reply sending is unavailable' : 'Write your reply...'}
                autoFocus
              />
            ) : (
              <QuickReplyComposer
                onExpand={() => setShowReplyComposer(true)}
              />
            )}
          </div>
        </div>

        {/* Lead Info Sidebar */}
        {showLeadInfo && lead && (
          <LeadInfoSidebar
            lead={lead}
            campaign={campaign}
            getInitials={getInitials}
          />
        )}
      </div>
    </div>
  )
}

interface MessageBubbleProps {
  message: ThreadMessage
  formatDate: (date: string) => string
  getInitials: (name: string | null, email: string) => string
}

/**
 * MessageBubble - Individual message in the thread
 */
function MessageBubble({
  message,
  formatDate,
  getInitials,
}: MessageBubbleProps) {
  const isOutbound = message.direction === 'outbound'

  return (
    <div
      className={cn(
        'rounded-lg border p-4 transition-colors',
        isOutbound
          ? 'bg-primary/5 border-primary/20 ml-8'
          : 'bg-card mr-8'
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Avatar className="h-9 w-9">
            {message.fromAvatar && (
              <AvatarImage src={message.fromAvatar} alt={message.fromName || message.from} />
            )}
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

        <div className="flex items-center gap-2 shrink-0">
          {message.isAutoDetected && message.category && (
            <Badge
              variant="outline"
              className={cn(
                'text-[10px] gap-1',
                categoryConfig[message.category]?.bgColor,
                categoryConfig[message.category]?.color
              )}
            >
              <Sparkles className="h-2.5 w-2.5" />
              AI
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            {formatDate(message.timestamp)}
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="mt-4 text-sm leading-relaxed">
        <MessageBody bodyText={message.bodyText} bodyHtml={message.bodyHtml} />
      </div>
    </div>
  )
}

interface LeadInfoSidebarProps {
  lead: LeadInfo
  campaign?: CampaignInfo | null
  getInitials: (name: string | null, email: string) => string
}

/**
 * LeadInfoSidebar - Lead information panel
 */
function LeadInfoSidebar({
  lead,
  campaign,
  getInitials,
}: LeadInfoSidebarProps) {
  const fullName = [lead.firstName, lead.lastName].filter(Boolean).join(' ')

  return (
    <div className="hidden lg:block w-72 border-l overflow-y-auto shrink-0">
      <div className="p-4 space-y-4">
        {/* Lead header */}
        <div className="flex items-center gap-3">
          <Avatar className="h-12 w-12">
            {lead.avatar && (
              <AvatarImage src={lead.avatar} alt={fullName || lead.email} />
            )}
            <AvatarFallback>
              {getInitials(fullName || null, lead.email)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            {fullName && (
              <div className="font-medium truncate">{fullName}</div>
            )}
            <div className="text-sm text-muted-foreground truncate">
              {lead.email}
            </div>
          </div>
        </div>

        <Separator />

        {/* Contact info */}
        <div className="space-y-3">
          {lead.company && (
            <div className="flex items-center gap-2 text-sm">
              <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="truncate">{lead.company}</span>
            </div>
          )}
          {lead.title && (
            <div className="flex items-center gap-2 text-sm">
              <Briefcase className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="truncate">{lead.title}</span>
            </div>
          )}
          {lead.phone && (
            <div className="flex items-center gap-2 text-sm">
              <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
              <a href={`tel:${lead.phone}`} className="hover:underline truncate">
                {lead.phone}
              </a>
            </div>
          )}
          {lead.linkedinUrl && (
            <a
              href={lead.linkedinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-blue-600 hover:underline"
            >
              <Linkedin className="h-4 w-4 shrink-0" />
              <span className="truncate">LinkedIn Profile</span>
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
          )}
        </div>

        <Separator />

        {/* Campaign info */}
        {campaign && (
          <>
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Campaign
              </div>
              <div className="text-sm truncate">{campaign.name}</div>
              <Badge variant="outline" className="text-xs">
                {campaign.status}
              </Badge>
            </div>
            <Separator />
          </>
        )}

        {/* Lead status */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Lead Status
          </div>
          <Badge variant="outline">{lead.status}</Badge>
        </div>

        {/* Actions */}
        <Separator />
        <div className="space-y-2">
          <Button variant="outline" size="sm" className="w-full">
            <User className="h-4 w-4 mr-2" />
            View Lead
          </Button>
          <Button variant="outline" size="sm" className="w-full">
            <Tag className="h-4 w-4 mr-2" />
            Add Tag
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * MessageDetailSkeleton - Loading state for message detail
 */
export function MessageDetailSkeleton() {
  return (
    <div className="flex flex-col h-full animate-pulse">
      {/* Header skeleton */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded bg-muted" />
          <div className="space-y-2">
            <div className="h-5 w-48 bg-muted rounded" />
            <div className="h-4 w-32 bg-muted rounded" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded bg-muted" />
          <div className="h-8 w-8 rounded bg-muted" />
          <div className="h-8 w-8 rounded bg-muted" />
        </div>
      </div>

      {/* Messages skeleton */}
      <div className="flex-1 p-4 space-y-4">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className={cn(
              'rounded-lg border p-4',
              i % 2 === 0 ? 'ml-8' : 'mr-8'
            )}
          >
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-full bg-muted" />
              <div className="space-y-2 flex-1">
                <div className="h-4 w-32 bg-muted rounded" />
                <div className="h-3 w-24 bg-muted rounded" />
              </div>
              <div className="h-3 w-16 bg-muted rounded" />
            </div>
            <div className="mt-4 space-y-2">
              <div className="h-4 w-full bg-muted rounded" />
              <div className="h-4 w-3/4 bg-muted rounded" />
              <div className="h-4 w-1/2 bg-muted rounded" />
            </div>
          </div>
        ))}
      </div>

      {/* Composer skeleton */}
      <div className="border-t p-4">
        <div className="h-12 w-full bg-muted rounded" />
      </div>
    </div>
  )
}
