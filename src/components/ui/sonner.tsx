"use client"

import { useSyncExternalStore } from "react"
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

// Canonical "have we hydrated yet" subscription: returns false during SSR and
// on the hydration pass, true afterwards. Replaces a setState-in-effect mount
// flag, which triggers a cascading re-render.
const emptySubscribe = () => () => {}
const useHasHydrated = () =>
  useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  )

const Toaster = ({ ...props }: ToasterProps) => {
  const hasHydrated = useHasHydrated()
  const { theme } = useTheme()

  // Avoid hydration mismatch by not rendering until hydrated
  if (!hasHydrated) {
    return null
  }

  const resolvedTheme = typeof theme === 'string' ? theme : 'dark'

  return (
    <Sonner
      theme={resolvedTheme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
