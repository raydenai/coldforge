'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import {
  Plus,
  Upload,
  MoreHorizontal,
  Trash2,
  Edit,
  Users,
  Mail,
  Building,
  RefreshCw,
  Search,
  FolderPlus,
  Check,
  X,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import {parseLeadCsv} from '@/lib/outreach/lead-csv'
import { toast } from 'sonner'

interface Lead {
  id: string
  email: string
  first_name?: string
  last_name?: string
  company?: string
  title?: string
  phone?: string|null
  status: 'active' | 'unsubscribed' | 'bounced' | 'complained'
  list_id?: string
  created_at: string
}

interface LeadList {
  id: string
  name: string
  description?: string
  lead_count: number
  created_at: string
}

const PAGE_SIZE = 50

export function LeadsContent() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [lists, setLists] = useState<LeadList[]>([])
  const [leadsLoading, setLeadsLoading] = useState(true)
  const [listsLoading, setListsLoading] = useState(true)
  const [leadsError, setLeadsError] = useState<string | null>(null)
  const [listsError, setListsError] = useState<string | null>(null)
  const [leadsMeasured, setLeadsMeasured] = useState(false)
  const [listsMeasured, setListsMeasured] = useState(false)
  const [activeTab, setActiveTab] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [allLeadsTotal, setAllLeadsTotal] = useState<number | null>(null)

  // Dialogs
  const [editingLeadId,setEditingLeadId] = useState<string|null>(null)
  const [showAddLeadDialog, setShowAddLeadDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [showCreateListDialog, setShowCreateListDialog] = useState(false)

  // Form states
  const [newLead, setNewLead] = useState({
    email: '',
    firstName: '',
    lastName: '',
    company: '',
    title: '',
    phone: '',
  })
  const [newListName, setNewListName] = useState('')
  const [phoneEdited,setPhoneEdited]=useState(false)
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importResult,setImportResult] = useState<{summary:string;messages:string[];totalMessages:number}|null>(null)
  const editorGeneration=useRef(0)
  const editorRequest=useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const leadsRequestId = useRef(0)
  const listsRequestId = useRef(0)

  // Leads and lists are independent reads. Each tracks loading, error and
  // measured-success separately so a failure in one never renders as a
  // measured zero in the other.
  const loadLeads = useCallback(async (targetPage: number, query: string, tabId: string) => {
    const requestId = ++leadsRequestId.current
    const trimmed = query.trim()
    setLeadsLoading(true)
    setLeadsError(null)
    try {
      const params = new URLSearchParams({
        page: String(targetPage),
        limit: String(PAGE_SIZE),
      })
      if (trimmed) params.set('search', trimmed)
      if (tabId !== 'all') params.set('listId', tabId)

      const response = await fetch(`/api/leads?${params.toString()}`)
      if (requestId !== leadsRequestId.current) return

      if (!response.ok) {
        // A failed read is unverified: clear prior counts rather than let a
        // stale or zero value masquerade as a successful measurement.
        setLeads([])
        setTotalPages(0)
        setLeadsMeasured(false)
        setAllLeadsTotal(null)
        setLeadsError('Could not load leads. Your audience is unverified.')
        return
      }

      const data = await response.json()
      if (requestId !== leadsRequestId.current) return

      const rows: Lead[] = Array.isArray(data.leads) ? data.leads : []
      const measuredTotal =
        typeof data.pagination?.total === 'number' ? data.pagination.total : rows.length
      // A deletion may remove the final page; re-read the last valid page.
      const lastPage = Math.max(1, typeof data.pagination?.totalPages === 'number' ? data.pagination.totalPages : Math.ceil(measuredTotal / PAGE_SIZE))
      if (targetPage > lastPage) { setPage(lastPage); return }
      setLeads(rows)
      setTotalPages(
        typeof data.pagination?.totalPages === 'number'
          ? data.pagination.totalPages
          : measuredTotal > 0
            ? Math.ceil(measuredTotal / PAGE_SIZE)
            : 0,
      )
      setLeadsMeasured(true)
      // The card/tab represent the whole audience, so only an unfiltered
      // "all" read may update the global total.
      if (tabId === 'all' && trimmed === '') setAllLeadsTotal(measuredTotal)
    } catch (error) {
      if (requestId !== leadsRequestId.current) return
      console.error('Failed to fetch leads:', error)
      setLeads([])
      setTotalPages(0)
      setLeadsMeasured(false)
      setAllLeadsTotal(null)
      setLeadsError('Could not load leads. Your audience is unverified.')
      toast.error('Failed to load leads')
    } finally {
      if (requestId === leadsRequestId.current) setLeadsLoading(false)
    }
  }, [])

  const loadLists = useCallback(async () => {
    const requestId = ++listsRequestId.current
    setListsLoading(true)
    setListsError(null)
    try {
      const response = await fetch('/api/leads/lists')
      if (requestId !== listsRequestId.current) return
      if (!response.ok) {
        setLists([])
        setListsMeasured(false)
        setListsError('Could not load lists.')
        return
      }
      const data = await response.json()
      if (requestId !== listsRequestId.current) return
      setLists(Array.isArray(data.lists) ? data.lists : [])
      setListsMeasured(true)
    } catch (error) {
      if (requestId !== listsRequestId.current) return
      console.error('Failed to fetch lists:', error)
      setLists([])
      setListsMeasured(false)
      setListsError('Could not load lists.')
    } finally {
      if (requestId === listsRequestId.current) setListsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadLeads(page, searchQuery, activeTab)
  }, [page, searchQuery, activeTab, loadLeads])

  useEffect(() => {
    loadLists()
  }, [loadLists])

  function handleRefresh() {
    loadLeads(page, searchQuery, activeTab)
    loadLists()
  }

  function closeLeadEditor(){
    editorGeneration.current++;setPhoneEdited(false);setShowAddLeadDialog(false);setEditingLeadId(null);setCreating(false)
    setNewLead({email:'',firstName:'',lastName:'',company:'',title:'',phone:''})
  }
  function openNewLead(){
    editorGeneration.current++;setPhoneEdited(false);setEditingLeadId(null);setCreating(false)
    setNewLead({email:'',firstName:'',lastName:'',company:'',title:'',phone:''});setShowAddLeadDialog(true)
  }

  async function addLead() {
    if (!newLead.email.trim()) {
      toast.error('Email is required')
      return
    }

    const generation=editorGeneration.current,request=++editorRequest.current
    const isCurrent=()=>generation===editorGeneration.current&&request===editorRequest.current
    setCreating(true)
    try {
      const response = await fetch(editingLeadId ? `/api/leads/${editingLeadId}` : '/api/leads', {
        method: editingLeadId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(editingLeadId ? {} : {email: newLead.email}),
          firstName: newLead.firstName,
          lastName: newLead.lastName,
          company: newLead.company,
          title: newLead.title,
          ...(phoneEdited?{phone:newLead.phone.trim()}:{}),
        }),
      })

      if (response.ok) {
        if(isCurrent())closeLeadEditor()
        toast.success(editingLeadId ? 'Lead details updated' : 'Lead added successfully')
        // Re-read the audience instead of trusting a local mutation so the
        // server-measured total stays authoritative.
        if (page !== 1) {
          setPage(1)
        } else {
          loadLeads(1, searchQuery, activeTab)
        }
      } else {
        const error = await response.json()
        toast.error(typeof error.error === 'string' ? error.error : error.error?.message || 'Unable to save lead details')
      }
    } catch (error) {
      console.error('Failed to add lead:', error)
      toast.error('Failed to add lead')
    } finally {
      if(isCurrent())setCreating(false)
    }
  }

  async function deleteLead(id: string) {
    if (!confirm('Are you sure you want to delete this lead?')) return

    try {
      const response = await fetch(`/api/leads/${id}`, {
        method: 'DELETE',
      })

      if (response.ok) {
        toast.success('Lead deleted')
        loadLeads(page, searchQuery, activeTab)
        loadLists()
      } else {
        toast.error('Failed to delete lead')
      }
    } catch (error) {
      console.error('Failed to delete lead:', error)
      toast.error('Failed to delete lead')
    }
  }

  async function createList() {
    if (!newListName.trim()) {
      toast.error('List name is required')
      return
    }

    setCreating(true)
    try {
      const response = await fetch('/api/leads/lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newListName }),
      })

      if (response.ok) {
        const data = await response.json()
        setLists([data.list, ...lists])
        setListsMeasured(true)
        setShowCreateListDialog(false)
        setNewListName('')
        toast.success('List created successfully')
      } else {
        const error = await response.json()
        toast.error(error.error?.message || 'Failed to create list')
      }
    } catch (error) {
      console.error('Failed to create list:', error)
      toast.error('Failed to create list')
    } finally {
      setCreating(false)
    }
  }

  async function handleFileUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    if (!file.name.endsWith('.csv')) {
      toast.error('Please upload a CSV file')
      return
    }

    setImporting(true)
    setShowImportDialog(false)

    try {
      const text = await file.text()
      const {leads:leadsToImport,skipped,issues} = parseLeadCsv(text)
      const localMessages=issues.map(issue=>`CSV record ${issue.record}: ${issue.email || '(blank email)'} — ${issue.reason}`)

      if (leadsToImport.length === 0) {
        setImportResult({summary:`No valid leads sent; locally skipped ${skipped}`,messages:localMessages,totalMessages:skipped})
        toast.error('No valid leads found in CSV')
        setImporting(false)
        return
      }

      // Import in batches
      const response = await fetch('/api/leads/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leads: leadsToImport }),
      })

      if (response.ok) {
        const data = await response.json()
        const serverMessages:string[]=Array.isArray(data.errors)?data.errors.filter((message:unknown):message is string=>typeof message==='string'):[]
        const summary = `Imported ${data.imported}; updated ${data.updated ?? 0}; server skipped ${data.skipped ?? 0}; locally skipped ${skipped}`
        const messages=[...serverMessages.slice(0,100).map(message=>message.slice(0,1000)),...localMessages].slice(0,100)
        setImportResult({summary,messages,totalMessages:serverMessages.length+skipped})
        if(serverMessages.length||skipped)toast.error(`${summary}; some rows were not saved. Review the import result.`)
        else toast.success(summary)
        setPage(1)
        loadLeads(1, searchQuery, activeTab)
        loadLists()
      } else {
        const error = await response.json()
        toast.error(typeof error.error === 'string' ? error.error : error.error?.message || 'Failed to import leads')
      }
    } catch (error) {
      console.error('Failed to import leads:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to parse CSV file')
    } finally {
      setImporting(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const filteredLeads = leads
  const hasFilters = searchQuery.trim() !== '' || activeTab !== 'all'
  const activeCount = leads.filter(lead => lead.status === 'active').length
  const bouncedCount = leads.filter(lead => lead.status === 'bounced').length

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return <Badge className="bg-green-500">Active</Badge>
      case 'unsubscribed':
        return <Badge variant="secondary">Unsubscribed</Badge>
      case 'bounced':
        return <Badge variant="destructive">Bounced</Badge>
      default:
        return <Badge variant="outline">{status}</Badge>
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Leads</h1>
          <p className="text-muted-foreground">
            Manage your prospects and lead lists
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline"><Link href="/leads/validation">Verify lead emails</Link></Button>
          <Button variant="outline" onClick={handleRefresh} disabled={leadsLoading || listsLoading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${leadsLoading || listsLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button variant="outline" onClick={() => setShowImportDialog(true)}>
            <Upload className="mr-2 h-4 w-4" />
            Import CSV
          </Button>
          <Button onClick={openNewLead}>
            <Plus className="mr-2 h-4 w-4" />
            Add Lead
          </Button>
        </div>
      </div>

      {importResult && <section role="region" aria-label="CSV import result" className="rounded-lg border p-4 space-y-2">
        <h2 className="font-semibold">CSV import result</h2>
        <p role="status">{importResult.summary}</p>
        {importResult.messages.length>0 && <ul className="list-disc pl-5 break-words">{importResult.messages.map((message,index)=><li key={index}>{message}</li>)}</ul>}
        {importResult.totalMessages>importResult.messages.length && <p>Showing {importResult.messages.length} of {importResult.totalMessages} correction messages.</p>}
        <Button variant="outline" onClick={()=>setImportResult(null)}>Dismiss import result</Button>
      </section>}

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Leads</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="total-leads-count">
              {leadsMeasured && allLeadsTotal !== null ? allLeadsTotal : 'Unknown'}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active</CardTitle>
            <Check className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="active-leads-count">
              {leadsMeasured ? activeCount : 'Unknown'}
            </div>
            {leadsMeasured && (
              <p className="text-xs text-muted-foreground">On this page</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Bounced</CardTitle>
            <X className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="bounced-leads-count">
              {leadsMeasured ? bouncedCount : 'Unknown'}
            </div>
            {leadsMeasured && (
              <p className="text-xs text-muted-foreground">On this page</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Lists</CardTitle>
            <FolderPlus className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="lists-count">
              {listsMeasured ? lists.length : 'Unknown'}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search and Tabs */}
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search leads..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value)
              setPage(1)
            }}
            className="pl-10"
          />
        </div>
        {listsError && !listsLoading && (
          <span className="text-sm text-destructive">{listsError}</span>
        )}
        <Button variant="outline" onClick={() => setShowCreateListDialog(true)}>
          <FolderPlus className="mr-2 h-4 w-4" />
          New List
        </Button>
      </div>

      {/* Leads Table */}
      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          setActiveTab(value)
          setPage(1)
        }}
      >
        <TabsList>
          <TabsTrigger value="all" data-testid="all-leads-tab">
            All Leads ({leadsMeasured && allLeadsTotal !== null ? allLeadsTotal : 'Unknown'})
          </TabsTrigger>
          {listsMeasured && lists.map(list => (
            <TabsTrigger key={list.id} value={list.id}>
              {list.name} ({list.lead_count})
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={activeTab} className="mt-4">
          <div className="space-y-4">
            {leadsLoading ? (
              <div className="space-y-2">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-12 bg-muted animate-pulse rounded" />
                ))}
              </div>
            ) : leadsError ? (
              <Card>
                <CardHeader className="text-center">
                  <div className="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
                    <AlertCircle className="h-6 w-6 text-destructive" />
                  </div>
                  <CardTitle>Couldn&apos;t load leads</CardTitle>
                  <CardDescription>{leadsError}</CardDescription>
                </CardHeader>
                <CardContent className="flex justify-center">
                  <Button variant="outline" onClick={handleRefresh} disabled={leadsLoading}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Retry
                  </Button>
                </CardContent>
              </Card>
            ) : filteredLeads.length === 0 ? (
              <Card>
                <CardHeader className="text-center">
                  <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                    <Users className="h-6 w-6 text-primary" />
                  </div>
                  <CardTitle>{hasFilters ? 'No matching leads' : 'No leads yet'}</CardTitle>
                  <CardDescription>
                    {hasFilters
                      ? 'Try a different search or list filter.'
                      : 'Import leads from a CSV file or add them manually to get started'}
                  </CardDescription>
                </CardHeader>
                {!hasFilters && (
                  <CardContent className="flex justify-center gap-4">
                    <Button variant="outline" onClick={() => setShowImportDialog(true)}>
                      <Upload className="mr-2 h-4 w-4" />
                      Import CSV
                    </Button>
                    <Button onClick={openNewLead}>
                      <Plus className="mr-2 h-4 w-4" />
                      Add Lead
                    </Button>
                  </CardContent>
                )}
              </Card>
            ) : (
              <Card>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Email</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Company</TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredLeads.map((lead) => (
                      <TableRow key={lead.id}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            <Mail className="h-4 w-4 text-muted-foreground" />
                            {lead.email}
                          </div>
                        </TableCell>
                        <TableCell>
                          {lead.first_name || lead.last_name
                            ? `${lead.first_name || ''} ${lead.last_name || ''}`.trim()
                            : '-'}
                        </TableCell>
                        <TableCell>
                          {lead.company ? (
                            <div className="flex items-center gap-2">
                              <Building className="h-4 w-4 text-muted-foreground" />
                              {lead.company}
                            </div>
                          ) : '-'}
                        </TableCell>
                        <TableCell>{lead.title || '-'}</TableCell>
                        <TableCell>{getStatusBadge(lead.status)}</TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm" aria-label={`Actions for ${lead.email}`}>
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onSelect={() => { editorGeneration.current++;setPhoneEdited(false);setCreating(false);setEditingLeadId(lead.id);setNewLead({email:lead.email,firstName:lead.first_name??'',lastName:lead.last_name??'',company:lead.company??'',title:lead.title??'',phone:lead.phone??''});setShowAddLeadDialog(true) }}>
                                <Edit className="mr-2 h-4 w-4" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-red-600"
                                onClick={() => deleteLead(lead.id)}
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            )}

            {!leadsLoading && !leadsError && totalPages > 1 && (
              <div className="flex items-center justify-between px-1">
                <p className="text-sm text-muted-foreground">
                  Page {page} of {totalPages}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    aria-label="Next page"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* Hidden file input for CSV import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        onChange={handleFileUpload}
        className="hidden"
      />

      {/* Add Lead Dialog */}
      <Dialog open={showAddLeadDialog} onOpenChange={open=>{if(!open)closeLeadEditor();else setShowAddLeadDialog(true)}}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingLeadId ? 'Edit lead details' : 'Add New Lead'}</DialogTitle>
            <DialogDescription>
              {editingLeadId ? 'Update contact details. Email and verification are preserved.' : 'Add a single lead to your database'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="email">Email *</Label>
              <Input
                id="email"
                readOnly={!!editingLeadId}
                type="email"
                placeholder="john@company.com"
                value={newLead.email}
                onChange={(e) => setNewLead({ ...newLead, email: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" type="tel" inputMode="tel" maxLength={50} aria-describedby="phone-help" placeholder="+14155552671" value={newLead.phone} onChange={event=>{setPhoneEdited(true);setNewLead({...newLead,phone:event.target.value})}} />
              <p id="phone-help" className="text-sm text-muted-foreground">Use international format. Call approval is managed separately.</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="firstName">First Name</Label>
                <Input
                  id="firstName"
                  placeholder="John"
                  value={newLead.firstName}
                  onChange={(e) => setNewLead({ ...newLead, firstName: e.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="lastName">Last Name</Label>
                <Input
                  id="lastName"
                  placeholder="Doe"
                  value={newLead.lastName}
                  onChange={(e) => setNewLead({ ...newLead, lastName: e.target.value })}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="company">Company</Label>
              <Input
                id="company"
                placeholder="Acme Inc"
                value={newLead.company}
                onChange={(e) => setNewLead({ ...newLead, company: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="title">Job Title</Label>
              <Input
                id="title"
                placeholder="CEO"
                value={newLead.title}
                onChange={(e) => setNewLead({ ...newLead, title: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeLeadEditor}>
              Cancel
            </Button>
            <Button onClick={addLead} disabled={creating}>
              {creating ? 'Saving...' : editingLeadId ? 'Save lead changes' : 'Add Lead'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import Dialog */}
      <Dialog open={showImportDialog} onOpenChange={setShowImportDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import Leads from CSV</DialogTitle>
            <DialogDescription>
              Upload a CSV file with your leads. Required column: email. Optional: first_name, last_name, company, title.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="border-2 border-dashed rounded-lg p-8 text-center">
              <Upload className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-sm text-muted-foreground mb-4">
                Drag and drop your CSV file here, or click to browse
              </p>
              <Button onClick={() => fileInputRef.current?.click()} disabled={importing}>
                {importing ? 'Importing...' : 'Select CSV File'}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowImportDialog(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create List Dialog */}
      <Dialog open={showCreateListDialog} onOpenChange={setShowCreateListDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New List</DialogTitle>
            <DialogDescription>
              Create a list to organize your leads
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="listName">List Name</Label>
              <Input
                id="listName"
                placeholder="e.g., Hot Prospects Q1"
                value={newListName}
                onChange={(e) => setNewListName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createList()}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateListDialog(false)}>
              Cancel
            </Button>
            <Button onClick={createList} disabled={creating}>
              {creating ? 'Creating...' : 'Create List'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
