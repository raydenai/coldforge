'use client'

import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Plus,
  Search,
  Users,
  Mail,
  CheckCircle,
  XCircle,
  Clock,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { toast } from 'sonner'

interface CampaignLeadsProps {
  campaignId: string
  onUpdated?: (updatedAt: string) => void
}

interface Lead {
  id: string
  email: string
  firstName?: string
  lastName?: string
  company?: string
  title?: string
  status: 'pending' | 'in_progress' | 'completed' | 'replied' | 'bounced' | 'unsubscribed'
  currentStep: number
  lastSentAt?: string
  nextSendAt?: string
}

interface LeadList {
  id: string
  name: string
  leadCount: number
}

export function CampaignLeads({ campaignId, onUpdated }: CampaignLeadsProps) {
  const [leads, setLeads] = useState<Lead[]>([])
  const [leadLists, setLeadLists] = useState<LeadList[]>([])
  const [loading, setLoading] = useState(true)
  const [readError, setReadError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [showAddLeads, setShowAddLeads] = useState(false)
  const [selectedLists, setSelectedLists] = useState<string[]>([])
  const [adding, setAdding] = useState(false)
  const leadsRequestId = useRef(0)

  const pageSize = 25

  useEffect(() => {
    fetchLeads()
    fetchLeadLists()
  }, [campaignId, currentPage, statusFilter, searchQuery])

  async function fetchLeads() {
    const requestId = ++leadsRequestId.current
    setLoading(true)
    setReadError(null)
    try {
      const params = new URLSearchParams({
        page: currentPage.toString(),
        limit: pageSize.toString(),
      })
      if (statusFilter !== 'all') params.append('status', statusFilter)
      if (searchQuery) params.append('search', searchQuery)

      const response = await fetch(`/api/campaigns/${campaignId}/leads?${params}`)
      if (requestId !== leadsRequestId.current) return
      if (!response.ok) {
        setReadError('Could not load this campaign’s leads. The audience is unverified.')
        return
      }
      const data = await response.json()
      if (requestId !== leadsRequestId.current) return
      setLeads(data.leads || [])
      setTotalPages(data.totalPages || 1)
    } catch (error) {
      if (requestId !== leadsRequestId.current) return
      console.error('Failed to fetch leads:', error)
      setReadError('Could not load this campaign’s leads. The audience is unverified.')
      toast.error('Failed to load leads')
    } finally {
      if (requestId === leadsRequestId.current) setLoading(false)
    }
  }

  async function fetchLeadLists() {
    try {
      const response = await fetch('/api/leads/lists')
      if (response.ok) {
        const data = await response.json()
        setLeadLists(data.lists || [])
      }
    } catch (error) {
      console.error('Failed to fetch lead lists:', error)
    }
  }

  async function addLeadsFromLists() {
    if (selectedLists.length === 0) {
      toast.error('Please select at least one lead list')
      return
    }

    setAdding(true)
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listIds: selectedLists }),
      })

      if (response.ok) {
        const data = await response.json()
        onUpdated?.(data.campaign.updatedAt)
        toast.success(`Added ${data.addedCount} validated leads to campaign`)
        setShowAddLeads(false)
        setSelectedLists([])
        fetchLeads()
      } else {
        const error = await response.json()
        toast.error(error.error?.message || 'Failed to add leads')
      }
    } catch (error) {
      console.error('Failed to add leads:', error)
      toast.error('Failed to add leads')
    } finally {
      setAdding(false)
    }
  }

  const getStatusBadge = (status: Lead['status']) => {
    switch (status) {
      case 'pending':
        return <Badge variant="secondary"><Clock className="mr-1 h-3 w-3" />Pending</Badge>
      case 'in_progress':
        return <Badge variant="default"><Mail className="mr-1 h-3 w-3" />In Progress</Badge>
      case 'completed':
        return <Badge variant="outline"><CheckCircle className="mr-1 h-3 w-3" />Completed</Badge>
      case 'replied':
        return <Badge className="bg-green-500"><CheckCircle className="mr-1 h-3 w-3" />Replied</Badge>
      case 'bounced':
        return <Badge variant="destructive"><XCircle className="mr-1 h-3 w-3" />Bounced</Badge>
      case 'unsubscribed':
        return <Badge variant="outline" className="text-red-600"><AlertCircle className="mr-1 h-3 w-3" />Unsubscribed</Badge>
      default:
        return <Badge variant="secondary">{status}</Badge>
    }
  }

  return (
    <div className="space-y-4">
      {/* Actions */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 flex-1">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search leads..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="in_progress">In Progress</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="replied">Replied</SelectItem>
              <SelectItem value="bounced">Bounced</SelectItem>
              <SelectItem value="unsubscribed">Unsubscribed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setShowAddLeads(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Leads
        </Button>
      </div>

      {/* Leads Table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-4 space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-20" />
                </div>
              ))}
            </div>
          ) : readError ? (
            <div role="alert" className="flex flex-col items-center justify-center py-12">
              <AlertCircle className="h-12 w-12 text-destructive mb-4" />
              <h3 className="font-semibold mb-1">Couldn&apos;t load leads</h3>
              <p className="text-sm text-muted-foreground mb-4 text-center max-w-sm">
                {readError}
              </p>
              <Button variant="outline" onClick={fetchLeads} disabled={loading}>
                Retry
              </Button>
            </div>
          ) : leads.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Users className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="font-semibold mb-1">No leads in this campaign</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Add leads from your lead lists to get started
              </p>
              <Button onClick={() => setShowAddLeads(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Add Leads
              </Button>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Lead</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Step</TableHead>
                    <TableHead>Last Sent</TableHead>
                    <TableHead>Next Send</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leads.map((lead) => (
                    <TableRow key={lead.id}>
                      <TableCell>
                        <div>
                          <p className="font-medium">
                            {lead.firstName} {lead.lastName}
                          </p>
                          <p className="text-sm text-muted-foreground">{lead.email}</p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div>
                          <p className="font-medium">{lead.company || '-'}</p>
                          <p className="text-sm text-muted-foreground">{lead.title || ''}</p>
                        </div>
                      </TableCell>
                      <TableCell>{getStatusBadge(lead.status)}</TableCell>
                      <TableCell>
                        <span className="font-medium">{lead.currentStep}</span>
                      </TableCell>
                      <TableCell>
                        {lead.lastSentAt
                          ? new Date(lead.lastSentAt).toLocaleDateString()
                          : '-'}
                      </TableCell>
                      <TableCell>
                        {lead.nextSendAt
                          ? new Date(lead.nextSendAt).toLocaleDateString()
                          : '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-3 border-t">
                  <p className="text-sm text-muted-foreground">
                    Page {currentPage} of {totalPages}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                      disabled={currentPage === totalPages}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Add Leads Dialog */}
      <Dialog open={showAddLeads} onOpenChange={setShowAddLeads}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Leads to Campaign</DialogTitle>
            <DialogDescription>
              Select lead lists to add to this campaign
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {leadLists.length === 0 ? (
              <div className="text-center py-8">
                <Users className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <p className="text-sm text-muted-foreground">
                  No lead lists available. Create a lead list first.
                </p>
              </div>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {leadLists.map((list) => (
                  <label
                    key={list.id}
                    className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selectedLists.includes(list.id)
                        ? 'border-primary bg-primary/5'
                        : 'hover:bg-muted'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedLists.includes(list.id)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedLists([...selectedLists, list.id])
                        } else {
                          setSelectedLists(selectedLists.filter(id => id !== list.id))
                        }
                      }}
                      className="rounded border-gray-300"
                    />
                    <div className="flex-1">
                      <p className="font-medium">{list.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {list.leadCount} leads
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddLeads(false)}>
              Cancel
            </Button>
            <Button
              onClick={addLeadsFromLists}
              disabled={adding || selectedLists.length === 0}
            >
              {adding ? 'Adding...' : `Add ${selectedLists.length} List${selectedLists.length !== 1 ? 's' : ''}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
