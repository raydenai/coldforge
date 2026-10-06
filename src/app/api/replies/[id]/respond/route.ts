import { type NextRequest } from 'next/server'
import { unavailableTransport } from '@/lib/email-core/transport-gate'
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  void context // Framework route contract; no effect occurs while transport is unavailable.
  return unavailableTransport(request)
}
