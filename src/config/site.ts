export const siteConfig = {
  name: 'InstantScale',
  description: 'Cold email outreach workspace with Winnr mailboxes',
  url: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  ogImage: '/og.png',
  links: {
    github: 'https://github.com',
  },
}

export const navConfig = {
  mainNav: [
    { title: 'Dashboard', href: '/dashboard' },
    { title: 'Campaigns', href: '/campaigns' },
    { title: 'Leads', href: '/leads' },
  ],
  sidebarNav: [
    { title: 'Winnr', href: '/winnr', icon: 'Mail' },
    { title: 'Dashboard', href: '/dashboard', icon: 'LayoutDashboard' },
    { title: 'Campaigns', href: '/campaigns', icon: 'Send' },
    { title: 'Leads', href: '/leads', icon: 'Users' },
    { title: 'Inbox', href: '/inbox', icon: 'Inbox' },
    { title: 'Settings', href: '/settings', icon: 'Settings' },
  ],
}

export const planLimits = {
  starter: {
    emailAccounts: 5,
    leads: 1000,
    emailsPerDay: 500,
    domains: 2,
  },
  pro: {
    emailAccounts: 25,
    leads: 10000,
    emailsPerDay: 5000,
    domains: 10,
  },
  agency: {
    emailAccounts: 100,
    leads: 100000,
    emailsPerDay: 50000,
    domains: 50,
  },
}
