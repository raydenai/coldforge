'use client'

import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Mail,
  Loader2,
  CheckCircle,
  XCircle,
  AlertCircle,
  Copy,
  Download,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface ProviderConfig {
  id: string
  provider: string
  domain: string
  configName: string
  mailboxLimit: number
  mailboxesCreated: number
}

interface ProvisionResult {
  email: string
  password: string
  aliases: string[]
  success: boolean
  error?: string
}

interface BulkProvisionModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  onSuccess?: () => void
}

export function BulkProvisionModal({
  open,
  onOpenChange,
  workspaceId,
  onSuccess,
}: BulkProvisionModalProps) {
  const [step, setStep] = useState<'config' | 'provisioning' | 'results'>('config')
  const [isLoading, setIsLoading] = useState(false)
  const [providers, setProviders] = useState<ProviderConfig[]>([])

  // Form state
  const [selectedProvider, setSelectedProvider] = useState<string>('')
  const [count, setCount] = useState(10)
  const [nameGender, setNameGender] = useState<string>('neutral')
  const [nameRegion, setNameRegion] = useState<string>('us')
  const [generateAliases, setGenerateAliases] = useState(true)
  const [aliasCount, setAliasCount] = useState(2)
  const [setProfilePhoto, setSetProfilePhoto] = useState(true)
  const [setSignature, setSetSignature] = useState(true)
  const [startWarmup, setStartWarmup] = useState(true)

  // Results state
  const [results, setResults] = useState<ProvisionResult[]>([])
  const [summary, setSummary] = useState({ total: 0, completed: 0, failed: 0 })

  // Fetch provider configs
  useEffect(() => {
    if (open) {
      fetchProviders()
    }
  }, [open, workspaceId])

  const fetchProviders = async () => {
    try {
      const response = await fetch(`/api/email-providers?workspaceId=${workspaceId}`)
      const data = await response.json()
      if (data.providers) {
        setProviders(data.providers)
        if (data.providers.length > 0) {
          setSelectedProvider(data.providers[0].id)
        }
      }
    } catch (error) {
      console.error('Failed to fetch providers:', error)
    }
  }

  const selectedProviderData = providers.find(p => p.id === selectedProvider)
  const availableSlots = selectedProviderData
    ? selectedProviderData.mailboxLimit - selectedProviderData.mailboxesCreated
    : 0

  const handleProvision = async () => {
    if (!selectedProvider) return

    setStep('provisioning')
    setIsLoading(true)

    try {
      const response = await fetch('/api/mailboxes/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          providerConfigId: selectedProvider,
          domain: selectedProviderData?.domain,
          count,
          nameGender: nameGender !== 'neutral' ? nameGender : undefined,
          nameRegion,
          generateAliases,
          aliasCount,
          setProfilePhoto,
          setSignature,
          startWarmup,
        }),
      })

      const data = await response.json()

      if (data.mailboxes) {
        setResults(data.mailboxes)
        setSummary(data.summary)
        setStep('results')
        onSuccess?.()
      } else {
        throw new Error(data.error || 'Failed to provision mailboxes')
      }
    } catch (error) {
      console.error('Provisioning error:', error)
      setStep('results')
      setSummary({ total: count, completed: 0, failed: count })
    } finally {
      setIsLoading(false)
    }
  }

  const handleCopyCredentials = () => {
    const credentials = results
      .filter(r => r.success)
      .map(r => `${r.email}:${r.password}`)
      .join('\n')
    navigator.clipboard.writeText(credentials)
  }

  const handleDownloadCSV = () => {
    const csv = [
      'Email,Password,Aliases,Status',
      ...results.map(r =>
        `${r.email},${r.password || ''},"${r.aliases?.join(';') || ''}",${r.success ? 'Success' : r.error}`
      ),
    ].join('\n')

    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `mailboxes-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleClose = () => {
    setStep('config')
    setResults([])
    setSummary({ total: 0, completed: 0, failed: 0 })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[600px]">
        {step === 'config' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Mail className="h-5 w-5" />
                Bulk Provision Mailboxes
              </DialogTitle>
              <DialogDescription>
                Automatically create multiple mailboxes with generated names and credentials
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-6 py-4">
              {/* Provider Selection */}
              <div className="space-y-2">
                <Label>Email Provider</Label>
                <Select value={selectedProvider} onValueChange={setSelectedProvider}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map(p => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.configName} ({p.domain})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedProviderData && (
                  <p className="text-sm text-muted-foreground">
                    Available: {availableSlots} of {selectedProviderData.mailboxLimit}
                  </p>
                )}
              </div>

              {/* Count */}
              <div className="space-y-2">
                <Label>Number of Mailboxes</Label>
                <Input
                  type="number"
                  min={1}
                  max={Math.min(100, availableSlots)}
                  value={count}
                  onChange={(e) => setCount(Math.min(100, Math.max(1, parseInt(e.target.value) || 1)))}
                />
                {count > availableSlots && (
                  <p className="text-sm text-red-500">
                    Exceeds available quota ({availableSlots} available)
                  </p>
                )}
              </div>

              {/* Name Generation */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Name Gender Preference</Label>
                  <Select value={nameGender} onValueChange={setNameGender}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="neutral">Mixed</SelectItem>
                      <SelectItem value="male">Male</SelectItem>
                      <SelectItem value="female">Female</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Name Region</Label>
                  <Select value={nameRegion} onValueChange={setNameRegion}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="us">US Names</SelectItem>
                      <SelectItem value="uk">UK Names</SelectItem>
                      <SelectItem value="generic">Generic</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Options */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Generate Aliases</Label>
                    <p className="text-sm text-muted-foreground">
                      Create email aliases for each mailbox
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={generateAliases}
                      onCheckedChange={(checked) => setGenerateAliases(checked === true)}
                    />
                    {generateAliases && (
                      <Input
                        type="number"
                        min={1}
                        max={5}
                        value={aliasCount}
                        onChange={(e) => setAliasCount(parseInt(e.target.value) || 2)}
                        className="w-16"
                      />
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Set Profile Photos</Label>
                    <p className="text-sm text-muted-foreground">
                      Assign profile photos from pool
                    </p>
                  </div>
                  <Checkbox
                    checked={setProfilePhoto}
                    onCheckedChange={(checked) => setSetProfilePhoto(checked === true)}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Set Signatures</Label>
                    <p className="text-sm text-muted-foreground">
                      Apply default signature template
                    </p>
                  </div>
                  <Checkbox
                    checked={setSignature}
                    onCheckedChange={(checked) => setSetSignature(checked === true)}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Start Warmup</Label>
                    <p className="text-sm text-muted-foreground">
                      Begin email warmup immediately
                    </p>
                  </div>
                  <Checkbox
                    checked={startWarmup}
                    onCheckedChange={(checked) => setStartWarmup(checked === true)}
                  />
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                onClick={handleProvision}
                disabled={!selectedProvider || count > availableSlots}
              >
                Provision {count} Mailboxes
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'provisioning' && (
          <>
            <DialogHeader>
              <DialogTitle>Provisioning Mailboxes...</DialogTitle>
              <DialogDescription>
                This may take a few minutes. Please don&rsquo;t close this window.
              </DialogDescription>
            </DialogHeader>

            <div className="py-12 text-center">
              <Loader2 className="h-12 w-12 mx-auto mb-4 animate-spin text-primary" />
              <p className="text-lg font-medium">Creating {count} mailboxes</p>
              <p className="text-sm text-muted-foreground mt-2">
                Setting up accounts, aliases, and warmup...
              </p>
            </div>
          </>
        )}

        {step === 'results' && (
          <>
            <DialogHeader>
              <DialogTitle>Provisioning Complete</DialogTitle>
              <DialogDescription>
                {summary.completed} of {summary.total} mailboxes created successfully
              </DialogDescription>
            </DialogHeader>

            <div className="py-4 space-y-4">
              {/* Summary */}
              <div className="flex items-center gap-4">
                <div className="flex-1 p-3 rounded-lg bg-green-100 dark:bg-green-900/20 text-center">
                  <CheckCircle className="h-6 w-6 mx-auto mb-1 text-green-600" />
                  <p className="text-lg font-bold text-green-600">{summary.completed}</p>
                  <p className="text-xs text-muted-foreground">Successful</p>
                </div>
                {summary.failed > 0 && (
                  <div className="flex-1 p-3 rounded-lg bg-red-100 dark:bg-red-900/20 text-center">
                    <XCircle className="h-6 w-6 mx-auto mb-1 text-red-600" />
                    <p className="text-lg font-bold text-red-600">{summary.failed}</p>
                    <p className="text-xs text-muted-foreground">Failed</p>
                  </div>
                )}
              </div>

              {/* Results List */}
              <ScrollArea className="h-[300px] border rounded-lg p-4">
                <div className="space-y-2">
                  {results.map((result, index) => (
                    <div
                      key={index}
                      className={cn(
                        'p-3 rounded-lg border',
                        result.success
                          ? 'bg-green-50 dark:bg-green-900/10 border-green-200'
                          : 'bg-red-50 dark:bg-red-900/10 border-red-200'
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {result.success ? (
                            <CheckCircle className="h-4 w-4 text-green-600" />
                          ) : (
                            <XCircle className="h-4 w-4 text-red-600" />
                          )}
                          <span className="font-medium">{result.email}</span>
                        </div>
                        {result.success && (
                          <Badge variant="outline" className="font-mono text-xs">
                            {result.password}
                          </Badge>
                        )}
                      </div>
                      {result.aliases?.length > 0 && (
                        <p className="text-xs text-muted-foreground mt-1 ml-6">
                          Aliases: {result.aliases.join(', ')}
                        </p>
                      )}
                      {result.error && (
                        <p className="text-xs text-red-600 mt-1 ml-6">
                          <AlertCircle className="h-3 w-3 inline mr-1" />
                          {result.error}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>

              {/* Actions */}
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyCredentials}
                  disabled={summary.completed === 0}
                >
                  <Copy className="h-4 w-4 mr-2" />
                  Copy Credentials
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownloadCSV}
                  disabled={results.length === 0}
                >
                  <Download className="h-4 w-4 mr-2" />
                  Download CSV
                </Button>
              </div>
            </div>

            <DialogFooter>
              <Button onClick={handleClose}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
