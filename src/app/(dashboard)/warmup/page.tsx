import { redirect } from 'next/navigation'

/** Infrastructure is owned by Winnr; retained bookmarks resolve to its live views. */
export default function InfrastructurePage() {
  redirect('/winnr')
}
