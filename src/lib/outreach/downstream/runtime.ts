import { createOutreachEventRepository } from '@/lib/outreach/event-database'
import { createOutreachEventService, type OutreachEventService } from '@/lib/outreach/events'
import type { DownstreamProviderPorts } from './core'
import { createDownstreamRepository, type DownstreamRepository } from './database'
import { createCloseBotPort, createGhlPort, createRetellPort } from './providers'

export function createDownstreamPorts(): DownstreamProviderPorts {
  return { ghl: createGhlPort(), closebot: createCloseBotPort(), retell: createRetellPort() }
}

export interface DownstreamWorkerDeps {
  repository: DownstreamRepository
  events: OutreachEventService
  ports: DownstreamProviderPorts
}

export function createDownstreamWorkerDeps(): DownstreamWorkerDeps {
  return {
    repository: createDownstreamRepository(),
    events: createOutreachEventService({ repository: createOutreachEventRepository() }),
    ports: createDownstreamPorts(),
  }
}
