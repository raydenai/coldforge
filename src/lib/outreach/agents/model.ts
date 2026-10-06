import Anthropic from '@anthropic-ai/sdk'
import {remainingAgentTime} from './core'
export interface ModelPort{generate(input:{apiKey:string;model:string;system:string;data:unknown;deadlineAt?:number}):Promise<{output:unknown;servedModel:string}>}
/** Buffer only a bounded response before SDK/Supabase JSON parsing; own cancellation covers headers AND body. */
export async function fetchAgentResponse(fetcher:typeof fetch,url:RequestInfo|URL,init:RequestInit|undefined,deadlineAt:number|undefined,timeoutMs:number,maxBytes:number):Promise<Response>{
 const controller=new AbortController(),signal=init?.signal?AbortSignal.any([controller.signal,init.signal]):controller.signal
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined
 const cancel=()=>{controller.abort();void reader?.cancel().catch(()=>undefined)}
 const timer=setTimeout(cancel,remainingAgentTime(deadlineAt,timeoutMs))
 signal.addEventListener('abort',()=>{void reader?.cancel().catch(()=>undefined)},{once:true})
 try{const response=await fetcher(url,{...init,signal});if(signal.aborted)throw Error('Agent response deadline');const length=Number(response.headers.get('content-length'));if(length>maxBytes){cancel();await response.body?.cancel();throw Error('Agent response too large')}
  if(!response.body)return response
  reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0
  for(;;){const next=await reader.read();if(signal.aborted)throw Error('Agent response deadline');if(next.done)break;size+=next.value.byteLength;if(size>maxBytes){cancel();throw Error('Agent response too large')}chunks.push(next.value)}
  if(signal.aborted)throw Error('Agent response deadline');return new Response(Buffer.concat(chunks),{status:response.status,statusText:response.statusText,headers:response.headers})
 }finally{clearTimeout(timer);reader?.releaseLock()}
}
/** No tools, retries, account assumptions or unbounded SDK response-body allocation. */
export function createModelPort(options:{fetch?:typeof fetch;timeoutMs?:number;deadlineAt?:number}={}):ModelPort{return{async generate(input){const serialized=JSON.stringify({untrustedData:input.data});if(Buffer.byteLength(serialized,'utf8')>32000)throw Error('Model input exceeds limit');const deadline=input.deadlineAt??options.deadlineAt,timeout=remainingAgentTime(deadline,options.timeoutMs??8000);const client=new Anthropic({apiKey:input.apiKey,baseURL:'https://api.anthropic.com',maxRetries:0,timeout,fetch:(url,init)=>fetchAgentResponse(options.fetch??fetch,url,{...init,redirect:'error'},deadline,timeout,65536)});const response=await client.messages.create({model:input.model,max_tokens:1000,system:input.system,messages:[{role:'user',content:serialized}]});const text=response.content.filter(c=>c.type==='text').map(c=>c.text).join('');if(text.length>20000)throw Error('Invalid model output');return{output:JSON.parse(text),servedModel:response.model}}}}
