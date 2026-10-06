'use client'

import { useRouter } from 'next/navigation'
import { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuGroup,
} from '@/components/ui/dropdown-menu'
import {
  LogOut,
  Settings,
  User as UserIcon,
  HelpCircle,
  ChevronDown,
} from 'lucide-react'

interface UserNavProps {
  user: User
}

export function UserNav({ user }: UserNavProps) {
  const router = useRouter()

  const handleSignOut = async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const initials = user.user_metadata?.full_name
    ? user.user_metadata.full_name
        .split(' ')
        .map((n: string) => n[0])
        .join('')
        .toUpperCase()
    : user.email?.[0]?.toUpperCase() || '?'

  const displayName = user.user_metadata?.full_name || 'User'
  const email = user.email || ''

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="relative h-9 gap-2 rounded-full pl-1 pr-2 hover:bg-accent"
        >
          {/* Avatar with status indicator */}
          <div className="relative">
            <Avatar className="h-7 w-7 border border-border">
              <AvatarImage
                src={user.user_metadata?.avatar_url}
                alt={displayName}
              />
              <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                {initials}
              </AvatarFallback>
            </Avatar>
            {/* Online status dot */}
            <span className="absolute bottom-0 right-0 h-2 w-2 rounded-full border-2 border-background bg-emerald-500" />
          </div>

          {/* Name (hidden on mobile) */}
          <span className="hidden text-sm font-medium md:inline-block">
            {displayName.split(' ')[0]}
          </span>

          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-64" align="end" forceMount>
        {/* User info header */}
        <DropdownMenuLabel className="font-normal p-4">
          <div className="flex items-center gap-3">
            <Avatar className="h-10 w-10 border border-border">
              <AvatarImage
                src={user.user_metadata?.avatar_url}
                alt={displayName}
              />
              <AvatarFallback className="bg-primary/10 text-primary font-medium">
                {initials}
              </AvatarFallback>
            </Avatar>
            <div className="flex flex-col space-y-0.5">
              <p className="text-sm font-semibold leading-none">{displayName}</p>
              <p className="text-xs leading-none text-muted-foreground truncate max-w-[160px]">
                {email}
              </p>
            </div>
          </div>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        {/* Menu items */}
        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={() => router.push('/settings')}
            className="cursor-pointer gap-2 py-2.5"
          >
            <UserIcon className="h-4 w-4 text-muted-foreground" />
            <span>Profile</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => router.push('/settings')}
            className="cursor-pointer gap-2 py-2.5"
          >
            <Settings className="h-4 w-4 text-muted-foreground" />
            <span>Settings</span>
          </DropdownMenuItem>

        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={() => router.push('/help')}
            className="cursor-pointer gap-2 py-2.5"
          >
            <HelpCircle className="h-4 w-4 text-muted-foreground" />
            <span>Help & Support</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onClick={handleSignOut}
          className="cursor-pointer gap-2 py-2.5 text-red-500 focus:text-red-500 focus:bg-red-500/10"
        >
          <LogOut className="h-4 w-4" />
          <span>Log out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
