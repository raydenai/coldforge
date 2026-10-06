import type { Metadata } from 'next'
import PipelineContent from './pipeline-content'

export const metadata: Metadata = {
  title: 'Pipeline & bookings',
}

export default function PipelinePage() {
  return <PipelineContent />
}
