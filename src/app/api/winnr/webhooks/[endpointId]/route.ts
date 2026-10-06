import { NextResponse, type NextRequest } from 'next/server'
import { receiveWinnrEvent, readBoundedRequest } from '@/lib/outreach/ingestion'
import { createIngestionRepository } from '@/lib/outreach/ingestion-database'
import { winnrErrorResponse } from '@/app/api/winnr/_shared'
export async function POST(request:NextRequest,{params}:{params:Promise<{endpointId:string}>}) {
 let timer: ReturnType<typeof setTimeout> | undefined
 try {
  const work = async () => {
   const {endpointId}=await params
   const raw=await readBoundedRequest(request,65536,1500)
   const repository=createIngestionRepository()
   const result=await receiveWinnrEvent(endpointId,raw,{timestamp:request.headers.get('x-winnr-timestamp'),signature:request.headers.get('x-winnr-signature'),eventId:request.headers.get('x-winnr-event-id'),eventType:request.headers.get('x-winnr-event')},repository)
   return NextResponse.json(result)
  }
  // A DB acknowledgement lost at the deadline can still commit. Return500;
  // the provider's retry is safe because SQL dedupes the stable event identity.
  return await Promise.race([work(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Ingestion acknowledgement deadline')),9000)})])
 } catch(error){return winnrErrorResponse(error)} finally {clearTimeout(timer)}
}
