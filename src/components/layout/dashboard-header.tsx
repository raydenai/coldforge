'use client'

import { useState } from 'react'
import { User } from '@supabase/supabase-js'
import { usePathname } from 'next/navigation'
import {
  Search,
  Bell,
  Sparkles,
  Command,
  Plus,
} from 'lucide-react'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { UserNav } from '@/components/layout/user-nav'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface DashboardHeaderProps {
  user: User
}

const pageTitles: Record<string, { title: string; description: string }> = {
  '/dashboard': {
    title: 'Dashboard',
    description: 'Your command center for cold email outreach',
  },
  '/campaigns': {
    title: 'Campaigns',
    description: 'Manage your email sequences and outreach',
  },
  '/leads': {
    title: 'Leads',
    description: 'Your prospects and contact lists',
  },
  '/winnr': { title: 'Winnr', description: 'Mailbox connections, warming, and provider status' },
  '/inbox': {
    title: 'Inbox',
    description: 'Unified inbox for all replies',
  },
  '/settings': {
    title: 'Settings',
    description: 'Account and application settings',
  },
}

const quickActions = [
  { label: 'Create Campaign', icon: Plus, href: '/campaigns' },
  { label: 'Import Leads', icon: Plus, href: '/leads?import=true' },
  { label: 'Open Winnr', icon: Plus, href: '/winnr' },
]

export function DashboardHeader({ user }: DashboardHeaderProps) {
  const pathname = usePathname()
  const [searchFocused, setSearchFocused] = useState(false)

  // Get current page info
  const basePath = '/' + pathname.split('/')[1]
  const pageInfo = pageTitles[basePath] || {
    title: 'InstantScale',
    description: '',
  }

  return (
    <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-4 border-b border-border/40 bg-background/80 backdrop-blur-xl px-4 md:px-6">
      {/* Left section: Sidebar trigger and breadcrumb */}
      <div className="flex items-center gap-3">
        <SidebarTrigger className="-ml-1 h-8 w-8 text-muted-foreground hover:text-foreground transition-colors" />
        <Separator orientation="vertical" className="h-5 bg-border/60" />

        {/* Page title for desktop */}
        <div className="hidden md:flex flex-col">
          <h1 className="text-sm font-semibold leading-none">{pageInfo.title}</h1>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {pageInfo.description}
          </p>
        </div>
      </div>

      {/* Center section: Search */}
      <div className="flex-1 flex items-center justify-center px-4">
        <div
          className={cn(
            "relative w-full max-w-md transition-all duration-300",
            searchFocused && "max-w-lg"
          )}
        >
          <Search className={cn(
            "absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 transition-colors",
            searchFocused ? "text-primary" : "text-muted-foreground"
          )} />
          <Input
            placeholder="Search campaigns, leads, or emails..."
            className={cn(
              "w-full h-9 pl-9 pr-12 bg-muted/50 border-transparent",
              "placeholder:text-muted-foreground/60",
              "focus:bg-background focus:border-border focus:ring-1 focus:ring-primary/20",
              "transition-all duration-200"
            )}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
          />
          {/* Keyboard shortcut indicator */}
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
            <kbd className="pointer-events-none hidden h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground sm:flex">
              <Command className="h-3 w-3" />K
            </kbd>
          </div>
        </div>
      </div>

      {/* Right section: Actions and user menu */}
      <div className="flex items-center gap-2">
        {/* Quick actions dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              className="hidden sm:flex items-center gap-1.5 btn-gradient h-8 px-3 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>New</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
              Quick Actions
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {quickActions.map((action) => (
              <DropdownMenuItem key={action.label} className="cursor-pointer">
                <action.icon className="mr-2 h-4 w-4" />
                <span>{action.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Notifications */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative h-9 w-9 text-muted-foreground hover:text-foreground"
            >
              <Bell className="h-4 w-4" />
              {/* Notification badge */}
              <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-primary animate-pulse" />
              <span className="sr-only">Notifications</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Notifications</p>
          </TooltipContent>
        </Tooltip>

        {/* Upgrade button (desktop only) */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="hidden lg:flex items-center gap-1.5 h-9 px-3 text-xs text-muted-foreground hover:text-primary"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>Upgrade</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Upgrade to Pro for unlimited campaigns</p>
          </TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="h-5 bg-border/60 hidden sm:block" />

        {/* User navigation */}
        <UserNav user={user} />
      </div>
    </header>
  )
}
