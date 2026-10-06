'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Plus,
  GripVertical,
  Mail,
  Clock,
  Trash2,
  Copy,
  MoreHorizontal,
  Eye,
  Edit,
  Split,
  AlertCircle,
  Save,
  Variable,
  Check
} from 'lucide-react'
import { toast } from 'sonner'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  type EmailVariant,
  BUILT_IN_VARIABLES,
  generateStepId,
  generateVariantId,
  previewTemplate,
  analyzeSpintax,
  previewSpintaxVariations,
  checkVariationUniqueness,
  type SpintaxAnalysis,
} from '@/lib/campaigns'

interface SequenceEditorProps {
  campaignId: string
  isEditable: boolean
  onUpdated?: (updatedAt: string) => void
}

type ConditionType = 'always' | 'not_opened' | 'not_replied' | 'not_clicked'

interface Step {
  id: string
  order: number
  type: 'email'
  delayDays: number
  delayHours: number
  condition: ConditionType
  variants: EmailVariant[]
}

const CONDITION_OPTIONS = [
  { value: 'always', label: 'Always send', description: 'Send to all leads at this step' },
  { value: 'not_opened', label: 'Not opened previous', description: 'Only send if previous email was not opened' },
  { value: 'not_replied', label: 'Not replied', description: 'Only send if lead has not replied yet' },
  { value: 'not_clicked', label: 'Not clicked', description: 'Only send if previous email links were not clicked' },
]

export function SequenceEditor({ campaignId, isEditable, onUpdated }: SequenceEditorProps) {
  const [steps, setSteps] = useState<Step[]>([])
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)
  const [editingStep, setEditingStep] = useState<Step | null>(null)
  const [showStepEditor, setShowStepEditor] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [previewContent, setPreviewContent] = useState({ subject: '', body: '' })
  const [showVariables, setShowVariables] = useState(false)
  const [spintaxAnalysis, setSpintaxAnalysis] = useState<{
    subject: SpintaxAnalysis | null
    body: SpintaxAnalysis | null
    combined: { totalVariations: number; isValid: boolean; errors: string[] }
    subjectVariations: string[]
    bodyVariations: string[]
    uniquenessCheck: {
      totalVariations: number
      recipientCount: number
      coverageRatio: number
      isAdequate: boolean
      recommendation: string
    } | null
  }>({
    subject: null,
    body: null,
    combined: { totalVariations: 0, isValid: true, errors: [] },
    subjectVariations: [],
    bodyVariations: [],
    uniquenessCheck: null,
  })

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  useEffect(() => {
    fetchSequence()
  }, [campaignId])

  async function fetchSequence() {
    setLoading(true)
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/sequences`)
      if (response.ok) {
        const data = await response.json()
        setExpectedUpdatedAt(data.expectedUpdatedAt ?? null)
        if (data.steps && data.steps.length > 0) {
          setSteps(data.steps.map((step: Step) => ({
            ...step,
            condition: step.condition || 'always',
            variants: step.variants || [{
              id: generateVariantId(),
              name: 'Version A',
              weight: 100,
              subject: '',
              body: '',
              isPlainText: false,
            }],
          })))
        } else {
          // Initialize with default first step
          setSteps([createDefaultStep(1)])
        }
      }
    } catch (error) {
      console.error('Failed to fetch sequence:', error)
      toast.error('Failed to load sequence')
    } finally {
      setLoading(false)
    }
  }

  function createDefaultStep(order: number): Step {
    return {
      id: generateStepId(),
      order,
      type: 'email',
      delayDays: order === 1 ? 0 : 3,
      delayHours: 0,
      condition: 'always',
      variants: [{
        id: generateVariantId(),
        name: 'Version A',
        weight: 100,
        subject: '',
        body: '',
        isPlainText: false,
      }],
    }
  }

  function addStep() {
    const newStep = createDefaultStep(steps.length + 1)
    setSteps([...steps, newStep])
    setHasChanges(true)
    setEditingStep(newStep)
    setShowStepEditor(true)
  }

  function removeStep(stepId: string) {
    const updatedSteps = steps
      .filter(s => s.id !== stepId)
      .map((s, index) => ({ ...s, order: index + 1 }))
    setSteps(updatedSteps)
    setHasChanges(true)
  }

  function duplicateStep(step: Step) {
    const newStep: Step = {
      ...step,
      id: generateStepId(),
      order: steps.length + 1,
      variants: step.variants.map(v => ({
        ...v,
        id: generateVariantId(),
      })),
    }
    setSteps([...steps, newStep])
    setHasChanges(true)
    toast.success('Step duplicated')
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event

    if (over && active.id !== over.id) {
      setSteps((items) => {
        const oldIndex = items.findIndex(i => i.id === active.id)
        const newIndex = items.findIndex(i => i.id === over.id)
        const reordered = arrayMove(items, oldIndex, newIndex)
        return reordered.map((s, index) => ({ ...s, order: index + 1 }))
      })
      setHasChanges(true)
    }
  }

  function openStepEditor(step: Step) {
    setEditingStep({ ...step, variants: step.variants.map(v => ({ ...v })) })
    setShowStepEditor(true)
  }

  function saveStepChanges() {
    if (!editingStep) return

    setSteps(steps.map(s => s.id === editingStep.id ? editingStep : s))
    setHasChanges(true)
    setShowStepEditor(false)
    setEditingStep(null)
  }

  function addVariant() {
    if (!editingStep) return

    const variantCount = editingStep.variants.length
    const newWeight = Math.floor(100 / (variantCount + 1))

    // Redistribute weights
    const updatedVariants = editingStep.variants.map(v => ({
      ...v,
      weight: newWeight,
    }))

    updatedVariants.push({
      id: generateVariantId(),
      name: `Version ${String.fromCharCode(65 + variantCount)}`,
      weight: 100 - (newWeight * variantCount),
      subject: '',
      body: '',
      isPlainText: false,
    })

    setEditingStep({
      ...editingStep,
      variants: updatedVariants,
    })
  }

  function removeVariant(variantId: string) {
    if (!editingStep || editingStep.variants.length <= 1) return

    const remainingVariants = editingStep.variants.filter(v => v.id !== variantId)
    const weightPerVariant = Math.floor(100 / remainingVariants.length)
    const lastVariantWeight = 100 - (weightPerVariant * (remainingVariants.length - 1))

    const updatedVariants = remainingVariants.map((v, index) => ({
      ...v,
      weight: index === remainingVariants.length - 1 ? lastVariantWeight : weightPerVariant,
    }))

    setEditingStep({
      ...editingStep,
      variants: updatedVariants,
    })
  }

  function updateVariant(variantId: string, updates: Partial<EmailVariant>) {
    if (!editingStep) return

    setEditingStep({
      ...editingStep,
      variants: editingStep.variants.map(v =>
        v.id === variantId ? { ...v, ...updates } : v
      ),
    })
  }

  function openPreview(variant: EmailVariant) {
    const previewedSubject = previewTemplate(variant.subject)
    const previewedBody = previewTemplate(variant.body)
    setPreviewContent({ subject: previewedSubject, body: previewedBody })

    // Analyze spintax in subject and body
    const subjectAnalysis = analyzeSpintax(variant.subject)
    const bodyAnalysis = analyzeSpintax(variant.body)

    // Calculate combined variations (subject × body)
    const totalCombined = subjectAnalysis.totalVariations * bodyAnalysis.totalVariations
    const combinedErrors = [...subjectAnalysis.errors, ...bodyAnalysis.errors]

    // Generate sample variations
    const subjectVariations = subjectAnalysis.totalVariations > 1
      ? previewSpintaxVariations(variant.subject, 5)
      : [previewedSubject]
    const bodyVariations = bodyAnalysis.totalVariations > 1
      ? previewSpintaxVariations(variant.body, 3)
      : [previewedBody]

    // Check uniqueness coverage (assuming 1000 recipients as estimate)
    const estimatedRecipients = 1000
    const combinedText = `${variant.subject}\n${variant.body}`
    const uniquenessCheck = checkVariationUniqueness(combinedText, estimatedRecipients)

    setSpintaxAnalysis({
      subject: subjectAnalysis,
      body: bodyAnalysis,
      combined: {
        totalVariations: totalCombined,
        isValid: subjectAnalysis.isValid && bodyAnalysis.isValid,
        errors: combinedErrors,
      },
      subjectVariations,
      bodyVariations,
      uniquenessCheck,
    })

    setShowPreview(true)
  }

  function insertVariable(variable: string) {
    // This would need to be implemented with a text editor reference
    navigator.clipboard.writeText(variable)
    toast.success('Variable copied to clipboard')
  }

  async function saveSequence() {
    setSaving(true)
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/sequences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps, expectedUpdatedAt }),
      })

      if (response.ok) {
        const data = await response.json()
        setExpectedUpdatedAt(data.expectedUpdatedAt)
        onUpdated?.(data.expectedUpdatedAt)
        setHasChanges(false)
        toast.success('Sequence saved successfully')
      } else {
        const error = await response.json()
        toast.error(error.error?.message || 'Failed to save sequence')
      }
    } catch (error) {
      console.error('Failed to save sequence:', error)
      toast.error('Failed to save sequence')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <SequenceEditorSkeleton />
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Email Sequence</h2>
          <p className="text-sm text-muted-foreground">
            {steps.length} step{steps.length !== 1 ? 's' : ''} in your sequence
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasChanges && (
            <Badge variant="outline" className="text-yellow-600 border-yellow-600">
              Unsaved changes
            </Badge>
          )}
          <Button
            variant="outline"
            onClick={() => setShowVariables(true)}
          >
            <Variable className="mr-2 h-4 w-4" />
            Variables
          </Button>
          {isEditable && (
            <Button
              onClick={saveSequence}
              disabled={saving || !hasChanges}
            >
              <Save className="mr-2 h-4 w-4" />
              {saving ? 'Saving...' : 'Save Sequence'}
            </Button>
          )}
        </div>
      </div>

      {!isEditable && (
        <Card className="border-yellow-500/50 bg-yellow-500/10">
          <CardContent className="flex items-center gap-3 py-3">
            <AlertCircle className="h-5 w-5 text-yellow-600" />
            <p className="text-sm text-yellow-700">
              This campaign is currently active. Pause it to make changes to the sequence.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Sequence Steps */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={steps.map(s => s.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-4">
            {steps.map((step, index) => (
              <SortableStepCard
                key={step.id}
                step={step}
                isEditable={isEditable}
                isFirst={index === 0}
                onEdit={() => openStepEditor(step)}
                onRemove={() => removeStep(step.id)}
                onDuplicate={() => duplicateStep(step)}
                onPreview={(variant) => openPreview(variant)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* Add Step Button */}
      {isEditable && (
        <Button
          variant="outline"
          className="w-full border-dashed"
          onClick={addStep}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Step
        </Button>
      )}

      {/* Step Editor Dialog */}
      <Dialog open={showStepEditor} onOpenChange={setShowStepEditor}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingStep ? `Edit Step ${editingStep.order}` : 'Add Step'}
            </DialogTitle>
            <DialogDescription>
              Configure your email content and timing. One variant per step is supported.
            </DialogDescription>
          </DialogHeader>

          {editingStep && (
            <div className="space-y-6">
              {/* Timing & Conditions */}
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-4">
                  <h3 className="font-medium flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Delay from previous step
                  </h3>
                  <div className="flex gap-4">
                    <div className="flex-1 space-y-2">
                      <Label>Days</Label>
                      <Input
                        type="number"
                        min="0"
                        value={editingStep.delayDays}
                        onChange={(e) => setEditingStep({
                          ...editingStep,
                          delayDays: parseInt(e.target.value) || 0,
                        })}
                      />
                    </div>
                    <div className="flex-1 space-y-2">
                      <Label>Hours</Label>
                      <Input
                        type="number"
                        min="0"
                        max="23"
                        value={editingStep.delayHours}
                        onChange={(e) => setEditingStep({
                          ...editingStep,
                          delayHours: parseInt(e.target.value) || 0,
                        })}
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <h3 className="font-medium">Send Condition</h3>
                  <Select
                    value={editingStep.condition}
                    onValueChange={(value: ConditionType) => setEditingStep({
                      ...editingStep,
                      condition: value,
                    })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CONDITION_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          <div className="flex flex-col">
                            <span>{option.label}</span>
                            <span className="text-xs text-muted-foreground">
                              {option.description}
                            </span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Separator />

              {/* Variants */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium flex items-center gap-2">
                    <Split className="h-4 w-4" />
                    Email Variants
                    {editingStep.variants.length > 1 && (
                      <Badge variant="secondary">A/B Testing</Badge>
                    )}
                  </h3>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={addVariant}
                    disabled
                    title="Multiple variants are not supported by the current sequence storage"
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Variants unavailable
                  </Button>
                </div>

                <div className="space-y-4">
                  {editingStep.variants.map((variant) => (
                    <Card key={variant.id}>
                      <CardHeader className="py-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <Input
                              value={variant.name}
                              onChange={(e) => updateVariant(variant.id, { name: e.target.value })}
                              className="w-32 h-8"
                            />
                            {editingStep.variants.length > 1 && (
                              <div className="flex items-center gap-2">
                                <Label className="text-xs">Weight:</Label>
                                <Input
                                  type="number"
                                  min="0"
                                  max="100"
                                  value={variant.weight}
                                  onChange={(e) => updateVariant(variant.id, { weight: parseInt(e.target.value) || 0 })}
                                  className="w-16 h-8"
                                />
                                <span className="text-xs text-muted-foreground">%</span>
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => openPreview(variant)}
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                            {editingStep.variants.length > 1 && (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => removeVariant(variant.id)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="space-y-2">
                          <Label>Subject Line</Label>
                          <Input
                            value={variant.subject}
                            onChange={(e) => updateVariant(variant.id, { subject: e.target.value })}
                            placeholder="Enter subject line with {{variables}}"
                          />
                        </div>
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <Label>Email Body</Label>
                            <div className="flex items-center gap-2">
                              <Label htmlFor={`plaintext-${variant.id}`} className="text-xs">
                                Plain Text
                              </Label>
                              <Switch
                                id={`plaintext-${variant.id}`}
                                checked={variant.isPlainText}
                                onCheckedChange={(checked) => updateVariant(variant.id, { isPlainText: checked })}
                              />
                            </div>
                          </div>
                          <textarea
                            value={variant.body}
                            onChange={(e) => updateVariant(variant.id, { body: e.target.value })}
                            placeholder="Write your email content here. Use {{firstName}}, {{company}}, etc. for personalization"
                            className="w-full min-h-[200px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                          />
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowStepEditor(false)}>
              Cancel
            </Button>
            <Button onClick={saveStepChanges}>
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview Dialog - Enhanced with Spintax Analysis */}
      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Email Preview
              {spintaxAnalysis.combined.totalVariations > 1 && (
                <Badge variant="secondary" className="font-normal">
                  {spintaxAnalysis.combined.totalVariations.toLocaleString()} unique variations
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              Preview with sample data and spintax variations
            </DialogDescription>
          </DialogHeader>

          {/* Spintax Stats */}
          {spintaxAnalysis.combined.totalVariations > 1 && (
            <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Variation Analysis</span>
                {spintaxAnalysis.combined.isValid ? (
                  <Badge variant="outline" className="text-green-600 border-green-300">
                    <Check className="h-3 w-3 mr-1" />
                    Valid Spintax
                  </Badge>
                ) : (
                  <Badge variant="destructive">
                    Syntax Errors
                  </Badge>
                )}
              </div>

              <div className="grid grid-cols-3 gap-4 text-sm">
                <div className="space-y-1">
                  <p className="text-muted-foreground">Subject Variations</p>
                  <p className="text-lg font-semibold">{spintaxAnalysis.subject?.totalVariations?.toLocaleString() || 1}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-muted-foreground">Body Variations</p>
                  <p className="text-lg font-semibold">{spintaxAnalysis.body?.totalVariations?.toLocaleString() || 1}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-muted-foreground">Total Unique Emails</p>
                  <p className="text-lg font-semibold text-primary">{spintaxAnalysis.combined.totalVariations.toLocaleString()}</p>
                </div>
              </div>

              {/* Uniqueness Check */}
              {spintaxAnalysis.uniquenessCheck && (
                <div className={`rounded-md p-3 text-sm ${
                  spintaxAnalysis.uniquenessCheck.isAdequate
                    ? 'bg-green-50 text-green-800 border border-green-200'
                    : 'bg-amber-50 text-amber-800 border border-amber-200'
                }`}>
                  <div className="flex items-start gap-2">
                    {spintaxAnalysis.uniquenessCheck.isAdequate ? (
                      <Check className="h-4 w-4 mt-0.5 flex-shrink-0" />
                    ) : (
                      <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                    )}
                    <div>
                      <p className="font-medium">
                        {spintaxAnalysis.uniquenessCheck.isAdequate
                          ? 'Good for deliverability'
                          : 'May affect deliverability'}
                      </p>
                      <p className="text-xs mt-1">{spintaxAnalysis.uniquenessCheck.recommendation}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Errors if any */}
              {spintaxAnalysis.combined.errors.length > 0 && (
                <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-800">
                  <p className="font-medium mb-1">Spintax Errors:</p>
                  <ul className="list-disc list-inside space-y-1">
                    {spintaxAnalysis.combined.errors.map((error, i) => (
                      <li key={i}>{error}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="space-y-4">
            {/* Subject Preview */}
            <div className="space-y-2">
              <Label className="text-muted-foreground flex items-center gap-2">
                Subject
                {spintaxAnalysis.subjectVariations.length > 1 && (
                  <Badge variant="outline" className="text-xs font-normal">
                    {spintaxAnalysis.subjectVariations.length} samples
                  </Badge>
                )}
              </Label>
              {spintaxAnalysis.subjectVariations.length > 1 ? (
                <div className="space-y-2">
                  {spintaxAnalysis.subjectVariations.map((variation, index) => (
                    <div key={index} className="rounded-md border p-3 bg-muted/50 text-sm">
                      <span className="text-xs text-muted-foreground mr-2">#{index + 1}</span>
                      {variation || '(No subject)'}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-md border p-3 bg-muted/50">
                  {previewContent.subject || '(No subject)'}
                </div>
              )}
            </div>

            {/* Body Preview */}
            <div className="space-y-2">
              <Label className="text-muted-foreground flex items-center gap-2">
                Body
                {spintaxAnalysis.bodyVariations.length > 1 && (
                  <Badge variant="outline" className="text-xs font-normal">
                    {spintaxAnalysis.bodyVariations.length} samples
                  </Badge>
                )}
              </Label>
              {spintaxAnalysis.bodyVariations.length > 1 ? (
                <div className="space-y-2">
                  {spintaxAnalysis.bodyVariations.map((variation, index) => (
                    <div key={index} className="rounded-md border p-4 bg-white">
                      <div className="text-xs text-muted-foreground mb-2">Variation #{index + 1}</div>
                      <div
                        className="prose prose-sm max-w-none"
                        dangerouslySetInnerHTML={{ __html: variation.replace(/\n/g, '<br/>') || '(No content)' }}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  className="rounded-md border p-4 min-h-[150px] bg-white prose prose-sm max-w-none"
                  dangerouslySetInnerHTML={{ __html: previewContent.body.replace(/\n/g, '<br/>') || '(No content)' }}
                />
              )}
            </div>
          </div>

          <DialogFooter>
            <Button onClick={() => setShowPreview(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Variables Dialog */}
      <Dialog open={showVariables} onOpenChange={setShowVariables}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Template Variables</DialogTitle>
            <DialogDescription>
              Click on a variable to copy it to clipboard, then paste into your email
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {(['lead', 'company', 'sender', 'dynamic'] as const).map((category) => (
              <div key={category} className="space-y-2">
                <h4 className="font-medium capitalize">{category} Variables</h4>
                <div className="grid gap-2 md:grid-cols-2">
                  {BUILT_IN_VARIABLES.filter(v => v.category === category).map((variable) => (
                    <button
                      key={variable.key}
                      onClick={() => insertVariable(variable.key)}
                      className="flex items-start gap-3 p-3 rounded-md border hover:bg-muted text-left transition-colors"
                    >
                      <code className="text-xs bg-muted px-2 py-1 rounded font-mono">
                        {variable.key}
                      </code>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{variable.name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          Example: {variable.example}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button onClick={() => setShowVariables(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface SortableStepCardProps {
  step: Step
  isEditable: boolean
  isFirst: boolean
  onEdit: () => void
  onRemove: () => void
  onDuplicate: () => void
  onPreview: (variant: EmailVariant) => void
}

function SortableStepCard({
  step,
  isEditable,
  isFirst,
  onEdit,
  onRemove,
  onDuplicate,
  onPreview,
}: SortableStepCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: step.id, disabled: !isEditable })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const hasContent = step.variants.some(v => v.subject || v.body)
  const variant = step.variants[0]

  return (
    <div ref={setNodeRef} style={style}>
      {/* Connector line */}
      {!isFirst && (
        <div className="flex items-center gap-3 py-2 ml-6">
          <div className="w-px h-8 bg-border" />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            Wait {step.delayDays > 0 ? `${step.delayDays} day${step.delayDays > 1 ? 's' : ''}` : ''}
            {step.delayHours > 0 ? ` ${step.delayHours} hour${step.delayHours > 1 ? 's' : ''}` : ''}
            {step.delayDays === 0 && step.delayHours === 0 ? 'immediately' : ''}
          </div>
        </div>
      )}

      <Card className={`relative ${isDragging ? 'shadow-lg ring-2 ring-primary' : ''}`}>
        <CardContent className="p-4">
          <div className="flex items-start gap-4">
            {/* Drag handle */}
            {isEditable && (
              <button
                {...attributes}
                {...listeners}
                className="mt-1 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground"
              >
                <GripVertical className="h-5 w-5" />
              </button>
            )}

            {/* Step indicator */}
            <div className="flex flex-col items-center gap-1">
              <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-medium text-sm">
                {step.order}
              </div>
              <Mail className="h-4 w-4 text-muted-foreground" />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h4 className="font-medium">Step {step.order}</h4>
                    {step.variants.length > 1 && (
                      <Badge variant="secondary" className="gap-1">
                        <Split className="h-3 w-3" />
                        {step.variants.length} variants
                      </Badge>
                    )}
                    {step.condition !== 'always' && (
                      <Badge variant="outline" className="gap-1">
                        {CONDITION_OPTIONS.find(c => c.value === step.condition)?.label}
                      </Badge>
                    )}
                  </div>

                  {hasContent ? (
                    <div className="space-y-1">
                      <p className="text-sm font-medium truncate">
                        {variant?.subject || '(No subject)'}
                      </p>
                      <p className="text-xs text-muted-foreground line-clamp-2">
                        {variant?.body?.replace(/<[^>]*>/g, '') || '(No content)'}
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Click to add email content
                    </p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => variant && onPreview(variant)}
                        disabled={!hasContent || !variant}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Preview</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={onEdit}
                        disabled={!isEditable}
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Edit</TooltipContent>
                  </Tooltip>

                  {isEditable && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={onEdit}>
                          <Edit className="mr-2 h-4 w-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={onDuplicate}>
                          <Copy className="mr-2 h-4 w-4" />
                          Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={onRemove}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function SequenceEditorSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-24 mt-1" />
        </div>
        <Skeleton className="h-10 w-32" />
      </div>

      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i}>
            {i > 1 && (
              <div className="flex items-center gap-3 py-2 ml-6">
                <div className="w-px h-8 bg-border" />
                <Skeleton className="h-4 w-20" />
              </div>
            )}
            <Card>
              <CardContent className="p-4">
                <div className="flex items-start gap-4">
                  <Skeleton className="h-5 w-5" />
                  <Skeleton className="h-8 w-8 rounded-full" />
                  <div className="flex-1">
                    <Skeleton className="h-5 w-24 mb-2" />
                    <Skeleton className="h-4 w-full mb-1" />
                    <Skeleton className="h-3 w-3/4" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        ))}
      </div>
    </div>
  )
}
