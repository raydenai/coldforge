import { Suspense } from 'react'
import { ValidationContent } from './validation-content'

export default function LeadValidationPage() {
  return (
    <Suspense fallback={<ValidationLoading />}>
      <ValidationContent />
    </Suspense>
  )
}

function ValidationLoading() {
  return (
    <div className="space-y-6">
      <div className="h-8 w-56 bg-muted animate-pulse rounded" />
      <div className="h-4 w-96 bg-muted animate-pulse rounded" />
      <div className="h-40 bg-muted animate-pulse rounded-lg" />
    </div>
  )
}
