'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
// Select components imported but unused - removed to fix TypeScript error
import {
  Plus,
  MoreHorizontal,
  Play,
  Pause,
  Trash2,
  Edit,
  Mail,
  Eye,
  MousePointer,
  MessageSquare,
  RefreshCw,
  Rocket
} from 'lucide-react'
import { toast } from 'sonner'

interface Campaign {
  id: string
  name: string
  status: 'draft' | 'active' | 'paused' | 'completed' | 'archived'
  stats: {
    sent: number
    opened: number
    clicked: number
    replied: number
    bounced: number
  } | null
  createdAt: string
  updatedAt: string
}

export function CampaignsContent() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newCampaignName, setNewCampaignName] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    fetchCampaigns()
  }, [])

  async function fetchCampaigns() {
    setLoading(true)
    try {
      const response = await fetch('/api/campaigns')
      if (response.ok) {
        const data = await response.json()
        setCampaigns(data.campaigns || [])
      }
    } catch (error) {
      console.error('Failed to fetch campaigns:', error)
      toast.error('Failed to load campaigns')
    } finally {
      setLoading(false)
    }
  }

  async function createCampaign() {
    if (!newCampaignName.trim()) {
      toast.error('Please enter a campaign name')
      return
    }

    setCreating(true)
    try {
      const response = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newCampaignName }),
      })

      if (response.ok) {
        const data = await response.json()
        setCampaigns([data.campaign, ...campaigns])
        setShowCreateDialog(false)
        setNewCampaignName('')
        toast.success('Campaign created successfully')
      } else {
        const error = await response.json()
        toast.error(error.error?.message || 'Failed to create campaign')
      }
    } catch (error) {
      console.error('Failed to create campaign:', error)
      toast.error('Failed to create campaign')
    } finally {
      setCreating(false)
    }
  }

  async function updateCampaignStatus(id: string, status: string) {
    try {
      const response = await fetch(`/api/campaigns/${id}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: status === 'active' ? 'start' : 'pause' }),
      })

      if (response.ok) {
        const data = await response.json()
        const returnedStatus = data.status ?? data.campaign?.status
        if (!['draft', 'active', 'paused', 'completed', 'archived'].includes(returnedStatus)) {
          toast.error('Failed to update campaign')
          return
        }
        setCampaigns(previous => previous.map(c =>
          c.id === id ? { ...c, status: returnedStatus } : c
        ))
        toast.success(`Campaign ${returnedStatus === 'active' ? 'started' : returnedStatus}`)
      } else {
        const error = await response.json()
        toast.error(typeof error.error === 'string' ? error.error : error.error?.message || 'Failed to update campaign')
      }
    } catch (error) {
      console.error('Failed to update campaign:', error)
      toast.error('Failed to update campaign')
    }
  }

  async function deleteCampaign(id: string) {
    if (!confirm('Are you sure you want to delete this campaign?')) return

    try {
      const response = await fetch(`/api/campaigns/${id}`, {
        method: 'DELETE',
      })

      if (response.ok) {
        setCampaigns(campaigns.filter(c => c.id !== id))
        toast.success('Campaign deleted')
      } else {
        toast.error('Failed to delete campaign')
      }
    } catch (error) {
      console.error('Failed to delete campaign:', error)
      toast.error('Failed to delete campaign')
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active': return 'bg-green-500'
      case 'paused': return 'bg-yellow-500'
      case 'completed': return 'bg-blue-500'
      case 'draft': return 'bg-gray-500'
      default: return 'bg-gray-500'
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Campaigns</h1>
          <p className="text-muted-foreground">
            Create and manage your email campaigns
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={fetchCampaigns} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button onClick={() => setShowCreateDialog(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Campaign
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Campaigns</CardTitle>
            <Rocket className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{campaigns.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active</CardTitle>
            <Play className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {campaigns.filter(c => c.status === 'active').length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Sent</CardTitle>
            <Mail className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {campaigns.every(c => c.stats?.sent !== undefined) ? campaigns.reduce((sum, c) => sum + (c.stats?.sent ?? 0), 0) : 'Unknown'}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Replies</CardTitle>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {campaigns.every(c => c.stats?.replied !== undefined) ? campaigns.reduce((sum, c) => sum + (c.stats?.replied ?? 0), 0) : 'Unknown'}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Campaign List */}
      {loading ? (
        <div className="grid gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />
          ))}
        </div>
      ) : campaigns.length === 0 ? (
        <Card>
          <CardHeader className="text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <Rocket className="h-6 w-6 text-primary" />
            </div>
            <CardTitle>No campaigns yet</CardTitle>
            <CardDescription>
              Create your first campaign to start sending emails and growing your business
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Button onClick={() => setShowCreateDialog(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Create Your First Campaign
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {campaigns.map((campaign) => (
            <Card key={campaign.id} className="hover:shadow-md transition-shadow">
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className={`w-3 h-3 rounded-full ${getStatusColor(campaign.status)}`} />
                    <div>
                      <h3 className="font-semibold text-lg">{campaign.name}</h3>
                      <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
                        <Badge variant="secondary">{campaign.status}</Badge>
                        <span>Created {new Date(campaign.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="hidden md:flex items-center gap-6 text-sm">
                    <div className="flex items-center gap-1">
                      <Mail className="h-4 w-4 text-muted-foreground" />
                      <span>{campaign.stats?.sent ?? 'Unknown'} sent</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Eye className="h-4 w-4 text-muted-foreground" />
                      <span>{campaign.stats?.opened ?? 'Unknown'} opened</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <MousePointer className="h-4 w-4 text-muted-foreground" />
                      <span>{campaign.stats?.clicked ?? 'Unknown'} clicked</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <MessageSquare className="h-4 w-4 text-muted-foreground" />
                      <span>{campaign.stats?.replied ?? 'Unknown'} replies</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2">
                    {campaign.status === 'active' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => updateCampaignStatus(campaign.id, 'paused')}
                      >
                        <Pause className="h-4 w-4" />
                      </Button>
                    ) : campaign.status !== 'completed' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => updateCampaignStatus(campaign.id, 'active')}
                      >
                        <Play className="h-4 w-4" />
                      </Button>
                    ) : null}

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem>
                          <Edit className="mr-2 h-4 w-4" />
                          Edit Campaign
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-red-600"
                          onClick={() => deleteCampaign(campaign.id)}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create Campaign Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Campaign</DialogTitle>
            <DialogDescription>
              Give your campaign a name to get started. You can add sequences and leads later.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Campaign Name</Label>
              <Input
                id="name"
                placeholder="e.g., Q1 Outreach Campaign"
                value={newCampaignName}
                onChange={(e) => setNewCampaignName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createCampaign()}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button onClick={createCampaign} disabled={creating}>
              {creating ? 'Creating...' : 'Create Campaign'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
