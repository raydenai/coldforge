import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PipelineContent from '@/app/(dashboard)/pipeline/pipeline-content'

const read = {
  connections: [
    {
      provider: 'ghl',
      revision: 1,
      enabled: false,
      configured: true,
      config: { locationId: 'loc_1' },
      capability: { readOnlyCheck: 'supported' },
      lastCheckAt: null,
      lastCheckOk: null,
      lastCheckDetail: null,
      verifiedAt: null,
      updatedAt: '2026-10-05T00:00:00.000Z',
    },
    {
      provider: 'closebot',
      revision: 1,
      enabled: false,
      configured: false,
      config: {},
      capability: {},
      lastCheckAt: null,
      lastCheckOk: null,
      lastCheckDetail: null,
      verifiedAt: null,
      updatedAt: '2026-10-05T00:00:00.000Z',
    },
    {
      provider: 'retell',
      revision: 1,
      enabled: false,
      configured: true,
      config: { fromNumber: '+14155550999' },
      capability: { readOnlyCheck: 'unsupported' },
      lastCheckAt: null,
      lastCheckOk: null,
      lastCheckDetail: null,
      verifiedAt: null,
      updatedAt: '2026-10-05T00:00:00.000Z',
    },
  ],
  crmLinks: [],
  appointments: [],
  eligibility: [],
  callbacks: [],
  qualifications: [],
  bridge: [],
  effects: [],
  masterStop: false,
  generatedAt: '2026-10-05T00:00:00.000Z',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pipeline downstream setup', () => {
  it('renders provider setup from presence-only data and honest capability state', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => read }))
    vi.stubGlobal('fetch', fetchMock)
    render(<PipelineContent />)

    expect(await screen.findByText('GoHighLevel (CRM & calendar)')).toBeInTheDocument()
    expect(screen.getByText('CloseBot (qualification bridge)')).toBeInTheDocument()
    expect(screen.getByText('Retell (requested callbacks)')).toBeInTheDocument()
    expect(await screen.findByText('read-only check unsupported')).toBeInTheDocument()

    // Everything starts disabled: no provider is silently enabled.
    expect(screen.getAllByText('disabled').length).toBeGreaterThanOrEqual(3)
    // Credentials are presence-only; a stored token never reaches the browser.
    expect(screen.queryByDisplayValue(/secret|token|cipher/i)).toBeNull()
  })

  it('surfaces a failed load instead of showing a successful zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
    render(<PipelineContent />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  })

  it('disables booking until a contact, calendar and slot are selected', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => read }))
    vi.stubGlobal('fetch', fetchMock)
    render(<PipelineContent />)

    expect(await screen.findByText('Book an appointment')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Request appointment' })).toBeDisabled()
    // No calendars are fabricated before the operator asks the provider.
    expect(screen.getByText('No calendars loaded')).toBeInTheDocument()
    // Contacts/conversations load from the real endpoints.
    expect(fetchMock).toHaveBeenCalledWith('/api/leads?limit=50')
    expect(fetchMock).toHaveBeenCalledWith('/api/inbox?limit=50')
  })

  it('labels an unknown callback outcome as a hold, never as success', async () => {
    const withHold = {
      ...read,
      callbacks: [
        {
          id: 'cb-1',
          eligibility_id: 'e-1',
          lead_id: 'l-1',
          phone_e164: '+14155550100',
          status: 'unknown',
          provider_call_id: 'call_1',
          summary: null,
          created_at: '2026-10-05T00:00:00.000Z',
          settled_at: null,
        },
      ],
    }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => withHold })))
    render(<PipelineContent />)
    expect(await screen.findByText('held (unknown)')).toBeInTheDocument()
  })
  function journeyFetch(slotResponse?:Promise<unknown>){
   return vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input)
    if(url.startsWith('/api/leads'))return {ok:true,json:async()=>({leads:[{id:'lead1',email:'one@example.test',phone:'+14155550100'},{id:'lead2',email:'two@example.test',phone:'+14155550199'}]})}
    if(url.startsWith('/api/inbox'))return {ok:true,json:async()=>({threads:[{id:'thread1',leadId:'lead1',participantEmail:'one@example.test',participantName:'First person',subject:'Calendar request'},{id:'thread2',leadId:'lead2',participantEmail:'two@example.test',participantName:'Second person',subject:'Calendar request'}]})}
    if(init?.method==='POST'){
     const body=JSON.parse(String(init.body)) as {action:string}
     if(body.action==='listCalendars')return {ok:true,json:async()=>({calendars:[{id:'A',name:'Calendar A'},{id:'B',name:'Calendar B'}]})}
     if(body.action==='listSlots')return {ok:true,json:async()=>slotResponse??{slots:[{startAt:'2026-10-10T18:00:00.000Z',endAt:null}]}}
     return {ok:true,json:async()=>({saved:true})}
    }
    return {ok:true,json:async()=>({...read,connections:read.connections.map(c=>({...c,enabled:c.provider==='ghl'}))})}
   })
  }
  it('submits the displayed existing phone with explicit UTC expiry and clears consent on contact changes',async()=>{
   const fetch=journeyFetch();vi.stubGlobal('fetch',fetch);render(<PipelineContent/>);await screen.findByText('GoHighLevel (CRM & calendar)')
   await waitFor(()=>expect(screen.getByText('one@example.test · one@example.test')).toBeInTheDocument())
   fireEvent.change(screen.getByLabelText('Contact'),{target:{value:'lead1'}})
   expect(screen.getByLabelText('Phone (E.164)')).toHaveValue('+14155550100')
   fireEvent.change(screen.getByLabelText(/Expires at/),{target:{value:'2026-10-10T18:00'}})
   fireEvent.change(screen.getByLabelText('Consent basis'),{target:{value:'Recorded explicit consent'}})
   fireEvent.change(screen.getByLabelText('Evidence of consent'),{target:{value:'Synthetic operator note'}})
   expect(screen.getByRole('button',{name:'Record eligibility'})).toBeEnabled();fireEvent.click(screen.getByRole('button',{name:'Record eligibility'}))
   await waitFor(()=>expect(fetch.mock.calls.some(([,init])=>init?.body&&String(init.body).includes('recordEligibility'))).toBe(true))
   const call=fetch.mock.calls.find(([,init])=>init?.body&&String(init.body).includes('recordEligibility'));const body=JSON.parse(String(call?.[1]?.body)) as {phoneE164:string;expiresAt:string}
   expect(body.phoneE164).toBe('+14155550100');expect(body.expiresAt).toBe(new Date('2026-10-10T18:00').toISOString())
   fireEvent.change(screen.getByLabelText('Contact'),{target:{value:'lead2'}});expect(screen.getByLabelText('Consent basis')).toHaveValue('');expect(screen.getByRole('button',{name:'Record eligibility'})).toBeDisabled();expect(screen.getByLabelText('Phone (E.164)')).toHaveValue('+14155550199')
  })
  it('uses the real camelCase inbox identity and excludes another selected contact conversation',async()=>{
   vi.stubGlobal('fetch',journeyFetch());render(<PipelineContent/>);await screen.findByText('First person · Calendar request');fireEvent.change(screen.getByLabelText('Contact'),{target:{value:'lead1'}})
   expect(screen.getByText('First person · Calendar request')).toBeInTheDocument();expect(screen.queryByText('Second person · Calendar request')).toBeNull()
  })
  it('clears old slots on calendar/date changes and discards a late previous calendar response',async()=>{
   let release:(value:unknown)=>void=()=>{};const deferred=new Promise<unknown>(resolve=>{release=resolve});const fetch=journeyFetch(deferred);vi.stubGlobal('fetch',fetch);render(<PipelineContent/>);await screen.findByText('GoHighLevel (CRM & calendar)');fireEvent.click(screen.getByRole('button',{name:'Load calendars'}));await screen.findByText(/Calendar A/)
   fireEvent.change(screen.getByLabelText('Contact'),{target:{value:'lead1'}});fireEvent.change(screen.getByLabelText('Calendar'),{target:{value:'A'}});fireEvent.click(screen.getByRole('button',{name:'Load availability'}));fireEvent.change(screen.getByLabelText('Calendar'),{target:{value:'B'}})
   await act(async()=>{release({slots:[{startAt:'2026-10-10T18:00:00.000Z',endAt:null}]});await deferred})
   expect(screen.getByRole('button',{name:'Request appointment'})).toBeDisabled();expect(screen.queryByText('1 returned slot(s)')).toBeNull()
   fireEvent.click(screen.getByRole('button',{name:'Load availability'}));await screen.findByText('1 returned slot(s)')
   const slot=screen.getByRole('button',{name:new Date('2026-10-10T18:00:00.000Z').toLocaleString()});fireEvent.click(slot);expect(screen.getByRole('button',{name:'Request appointment'})).toBeEnabled()
   fireEvent.change(screen.getByLabelText('Date (UTC)'),{target:{value:'2026-10-11'}});expect(screen.getByRole('button',{name:'Request appointment'})).toBeDisabled();expect(screen.queryByText('1 returned slot(s)')).toBeNull()
  })

})
