import '@testing-library/jest-dom/vitest'
import { describe,it,expect,vi,afterEach } from 'vitest'
import { render,screen,cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ReplyComposer } from '@/components/inbox/reply-composer'
import { MessageDetail } from '@/components/inbox/message-detail'
afterEach(cleanup)
describe('manual reply composer',()=>{
 it('retains pending text and shows unknown reference when send fails',async()=>{const user=userEvent.setup();const send=vi.fn().mockRejectedValue(new Error('Outcome unknown; reference attempt-123. Do not resend.'));render(<TooltipProvider><ReplyComposer recipientEmail="lead@example.test" onSend={send} showToolbar={false} /></TooltipProvider>);const input=screen.getByRole('textbox');await user.type(input,'Human draft retained');await user.click(screen.getByRole('button',{name:/send/i}));expect(await screen.findByText('Outcome unknown; reference attempt-123. Do not resend.')).toBeTruthy();expect(input).toHaveValue('Human draft retained');expect(send).toHaveBeenCalledTimes(1)})
 it('offers explicit takeover when conversation is assist and sending is gated',async()=>{const takeover=vi.fn().mockResolvedValue(undefined);render(<TooltipProvider><MessageDetail thread={{id:'thread',subject:'Question',participantEmail:'lead@example.test',participantName:null,category:'interested',sentiment:'neutral',status:'active',messageCount:1}} messages={[]} navigation={{prev:null,next:null,currentIndex:1,total:1}} onNavigate={vi.fn()} onClose={vi.fn()} onArchive={vi.fn()} onStar={vi.fn()} onMarkUnread={vi.fn()} onCategoryChange={vi.fn()} onReply={vi.fn()} replyTransportAvailable={false} replyDisabledReason="human_takeover_required" onTakeover={takeover}/></TooltipProvider>);await userEvent.click(screen.getByRole('button',{name:'Take over conversation'}));expect(takeover).toHaveBeenCalledTimes(1)})
})
