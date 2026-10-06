'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  Send,
  Users,
  Globe,
  Inbox,
  Settings,
  Zap,
  ChevronRight,
  Sparkles,
  HelpCircle,
  CalendarCheck,
  type LucideIcon,
} from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface NavigationItem {
  title: string
  href: string
  icon: LucideIcon
  description: string
  badge?: string | null
  badgeColor?: string
}

const navigationItems: NavigationItem[] = [
  { title: 'Operations', href: '/operations', icon: Zap, description: 'Run and pause daily outreach' },
  { title: 'Delivery review', href: '/operations/reconciliation', icon: HelpCircle, description: 'Review held email outcomes' },
  { title: 'Agents', href: '/agents', icon: Sparkles, description: 'Offers, copy and conversation review' },
  { title: 'Pipeline', href: '/pipeline', icon: CalendarCheck, description: 'Qualification, bookings and callbacks' },
  { title: 'Winnr', href: '/winnr', icon: Globe, description: 'Email infrastructure' },
  {
    title: 'Dashboard',
    href: '/dashboard',
    icon: LayoutDashboard,
    description: 'Overview & analytics',
  },
  {
    title: 'Campaigns',
    href: '/campaigns',
    icon: Send,
    description: 'Email sequences',
    badge: null,
  },
  {
    title: 'Leads',
    href: '/leads',
    icon: Users,
    description: 'Manage prospects',
  },
  {
    title: 'Inbox',
    href: '/inbox',
    icon: Inbox,
    description: 'Unified inbox',
  },
]

const bottomItems = [
  {
    title: 'Settings',
    href: '/settings',
    icon: Settings,
    description: 'App settings',
  },
]

function NavItem({
  item,
  isActive,
  isCollapsed
}: {
  item: NavigationItem
  isActive: boolean
  isCollapsed: boolean
}) {
  const content = (
    <Link
      href={item.href}
      className={cn(
        "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200",
        isActive
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
        isCollapsed && "justify-center px-2"
      )}
    >
      {/* Active indicator */}
      {isActive && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 rounded-r-full bg-gradient-to-b from-primary to-primary/70" />
      )}

      {/* Icon container with glow effect on active */}
      <span className={cn(
        "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-all duration-200",
        isActive
          ? "bg-primary/15 text-primary shadow-[0_0_12px_rgba(var(--primary),0.15)]"
          : "text-muted-foreground group-hover:text-foreground group-hover:bg-accent"
      )}>
        <item.icon className="h-4 w-4" />
      </span>

      {!isCollapsed && (
        <>
          <span className="flex-1 truncate">{item.title}</span>

          {/* Badge */}
          {item.badge && (
            <span className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              item.badgeColor || "bg-primary/20 text-primary"
            )}>
              {item.badge}
            </span>
          )}

          {/* Hover arrow indicator */}
          <ChevronRight className={cn(
            "h-4 w-4 text-muted-foreground/50 transition-all duration-200",
            "opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0",
            isActive && "opacity-100 translate-x-0 text-primary/50"
          )} />
        </>
      )}
    </Link>
  )

  if (isCollapsed) {
    return (
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          {content}
        </TooltipTrigger>
        <TooltipContent side="right" className="flex items-center gap-2">
          <span>{item.title}</span>
          {item.badge && (
            <span className={cn(
              "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
              item.badgeColor || "bg-primary/20 text-primary"
            )}>
              {item.badge}
            </span>
          )}
        </TooltipContent>
      </Tooltip>
    )
  }

  return content
}

export function AppSidebar() {
  const pathname = usePathname()
  const { state } = useSidebar()
  const isCollapsed = state === 'collapsed'

  return (
    <Sidebar className="border-r-0">
      {/* Sidebar background with glassmorphism */}
      <div className="absolute inset-0 glass-sidebar" />

      {/* Content wrapper */}
      <div className="relative z-10 flex h-full flex-col">
        {/* Header with logo */}
        <SidebarHeader className={cn(
          "border-b border-border/50 px-4 py-4",
          isCollapsed && "px-2"
        )}>
          <Link
            href="/dashboard"
            className={cn(
              "flex items-center gap-3 transition-all duration-200",
              isCollapsed && "justify-center"
            )}
          >
            {/* Logo icon with gradient background */}
            <div className="relative">
              <div className="absolute inset-0 rounded-lg bg-gradient-to-br from-primary/40 to-primary/20 blur-md" />
              <div className="relative flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/80 shadow-lg">
                <Zap className="h-5 w-5 text-white" />
              </div>
            </div>

            {!isCollapsed && (
              <div className="flex flex-col">
                <span className="text-lg font-bold tracking-tight">
                  Instant<span className="text-primary">Scale</span>
                </span>
                <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                  Cold Email Platform
                </span>
              </div>
            )}
          </Link>
        </SidebarHeader>

        {/* Navigation content */}
        <SidebarContent className="px-3 py-4">
          <SidebarGroup>
            {!isCollapsed && (
              <SidebarGroupLabel className="px-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                Main Menu
              </SidebarGroupLabel>
            )}
            <SidebarGroupContent className="mt-2">
              <nav className="flex flex-col gap-1">
                {navigationItems.map((item) => (
                  <NavItem
                    key={item.href}
                    item={item}
                    isActive={pathname === item.href || (item.href !== '/operations' && pathname.startsWith(item.href + '/'))}
                    isCollapsed={isCollapsed}
                  />
                ))}
              </nav>
            </SidebarGroupContent>
          </SidebarGroup>

          {/* Divider with gradient */}
          <div className={cn(
            "my-4 h-px bg-gradient-to-r from-transparent via-border to-transparent",
            isCollapsed && "mx-2"
          )} />

          {/* Bottom navigation */}
          <SidebarGroup>
            {!isCollapsed && (
              <SidebarGroupLabel className="px-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                System
              </SidebarGroupLabel>
            )}
            <SidebarGroupContent className="mt-2">
              <nav className="flex flex-col gap-1">
                {bottomItems.map((item) => (
                  <NavItem
                    key={item.href}
                    item={item}
                    isActive={pathname === item.href}
                    isCollapsed={isCollapsed}
                  />
                ))}
              </nav>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="mt-auto border-t border-border/50 p-4">
          <Link href="/operations" aria-label="Review outreach readiness" className="flex items-center justify-center gap-2 rounded-md px-2 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
            <LayoutDashboard className="h-4 w-4 shrink-0" />
            {!isCollapsed && <span>Review outreach readiness</span>}
          </Link>
        </SidebarFooter>
      </div>

      {/* Rail for collapse/expand */}
      <SidebarRail />
    </Sidebar>
  )
}
