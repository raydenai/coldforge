#!/usr/bin/env node
/**
 * Standalone process to run BullMQ workers (email, warmup, campaign).
 * Requires Redis to be running (localhost:6379 or REDIS_HOST/REDIS_PORT).
 * Run: npm run dev:workers
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
config({ path: '.env' })

import { startAllWorkers, closeAllWorkers } from '../src/lib/queue/workers'

function main() {
  console.log('[Workers] Starting queue workers (email, warmup, campaign)...')
  startAllWorkers()
  console.log('[Workers] All workers running. Press Ctrl+C to stop.')
}

async function shutdown() {
  console.log('[Workers] Shutting down...')
  await closeAllWorkers()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

main()
