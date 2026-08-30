/**
 * AI Reply Generator
 *
 * Uses Claude AI to generate contextual, human-like replies for warmup emails.
 * This is critical for engagement metrics - replies must be natural and varied.
 *
 * Key features:
 * - Contextual reply generation based on original email
 * - Conversation thread continuation
 * - Tone and style matching
 * - Anti-pattern detection to avoid spam triggers
 * - Template fallback for rate limiting
 */

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@/lib/supabase/server';

/**
 * Read the leading text block out of an Anthropic response.
 *
 * Throws rather than returning a fallback: a non-text first block means the
 * model returned something we did not ask for, and silently warming with an
 * empty body would corrupt engagement metrics.
 */
function extractReplyText(response: Anthropic.Message): string {
  const block = response.content[0];

  if (!block || block.type !== 'text') {
    throw new Error(
      `Anthropic response did not start with a text block (received: ${block?.type ?? 'empty content'})`
    );
  }

  return block.text.trim();
}

// Reply types
export type ReplyType =
  | 'acknowledgment'
  | 'question'
  | 'follow_up'
  | 'positive'
  | 'scheduling'
  | 'gratitude'
  | 'continuation';

// Reply generation options
export interface ReplyOptions {
  originalSubject: string;
  originalBody: string;
  threadHistory?: Array<{ role: 'sent' | 'received'; content: string }>;
  senderName: string;
  recipientName: string;
  replyType?: ReplyType;
  maxLength?: number;
  tone?: 'professional' | 'casual' | 'friendly';
  includeQuestion?: boolean;
  addPersonalization?: boolean;
}

// Generated reply
export interface GeneratedReply {
  subject: string;
  body: string;
  replyType: ReplyType;
  confidence: number;
  spamScore: number;
  metadata: {
    tokensUsed: number;
    generationTime: number;
    model: string;
  };
}

// Template-based fallback reply
export interface TemplateReply {
  subject: string;
  body: string;
  category: string;
}

// Claude client singleton
let anthropic: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropic) {
    anthropic = new Anthropic();
  }
  return anthropic;
}

// Reply generation prompts
const REPLY_SYSTEM_PROMPT = `You are an AI assistant helping generate natural, human-like email replies for a warmup system. Your replies must:

1. Be contextually relevant to the original email
2. Sound completely natural and human
3. Vary in length and structure
4. Avoid spam trigger words and patterns
5. Sometimes include questions to encourage further conversation
6. Match the tone of the original email
7. Be professional but personable
8. Never mention being AI or automated

IMPORTANT: Generate ONLY the reply body text. Do not include greetings like "Hi [Name]" or signatures - those will be added separately.

Your replies should feel like they come from a real person having a genuine conversation.`;

const REPLY_TYPE_INSTRUCTIONS: Record<ReplyType, string> = {
  acknowledgment: 'Generate a brief acknowledgment of the email. Keep it short (1-2 sentences).',
  question: 'Generate a reply that asks a relevant follow-up question about the topic.',
  follow_up: 'Generate a reply that continues the conversation with additional relevant information.',
  positive: 'Generate an enthusiastic, positive reply that expresses interest or agreement.',
  scheduling: 'Generate a reply about availability or scheduling a time to discuss further.',
  gratitude: 'Generate a thankful reply expressing appreciation for the information shared.',
  continuation: 'Generate a reply that naturally continues an ongoing conversation thread.'
};

/**
 * Generate an AI-powered reply to an email
 */
export async function generateAIReply(options: ReplyOptions): Promise<GeneratedReply> {
  const startTime = Date.now();
  const client = getAnthropicClient();

  const {
    originalSubject,
    originalBody,
    threadHistory = [],
    senderName,
    recipientName,
    replyType = selectReplyType(originalBody),
    maxLength = 150,
    tone = 'professional',
    includeQuestion = Math.random() > 0.6,
    addPersonalization = true
  } = options;

  // Build context from thread history
  let threadContext = '';
  if (threadHistory.length > 0) {
    threadContext = '\n\nConversation history:\n' +
      threadHistory.map(msg =>
        `${msg.role === 'sent' ? recipientName : senderName}: ${msg.content}`
      ).join('\n');
  }

  // Build the prompt
  const userPrompt = `
Original email subject: ${originalSubject}
Original email body: ${stripHtml(originalBody)}
${threadContext}

Sender name: ${senderName}
Recipient name (you are replying as): ${recipientName}

Reply type: ${replyType}
Instructions: ${REPLY_TYPE_INSTRUCTIONS[replyType]}

Tone: ${tone}
Max length: approximately ${maxLength} words
${includeQuestion ? 'Include a natural follow-up question.' : ''}
${addPersonalization ? `Reference something specific from the original email.` : ''}

Generate ONLY the reply body text. No greeting or signature.`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: REPLY_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: userPrompt }
      ]
    });

    const generatedBody = extractReplyText(response);
    const generationTime = Date.now() - startTime;

    // Calculate spam score for the generated reply
    const spamScore = calculateReplySpamScore(generatedBody);

    // If spam score is too high, regenerate or use template
    if (spamScore > 30) {
      console.warn('Generated reply has high spam score, using template fallback');
      return templateFallback(options, startTime);
    }

    // Generate appropriate subject
    const subject = generateReplySubject(originalSubject);

    return {
      subject,
      body: generatedBody,
      replyType,
      confidence: 0.95,
      spamScore,
      metadata: {
        tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
        generationTime,
        model: 'claude-sonnet-4-20250514'
      }
    };
  } catch (error) {
    console.error('AI reply generation failed:', error);
    return templateFallback(options, startTime);
  }
}

/**
 * Generate reply subject line
 */
function generateReplySubject(originalSubject: string): string {
  // Clean up the original subject
  let subject = originalSubject.trim();

  // Remove existing Re: prefixes
  subject = subject.replace(/^(Re:\s*)+/i, '').trim();

  // Add Re: prefix
  return `Re: ${subject}`;
}

/**
 * Select appropriate reply type based on email content
 */
function selectReplyType(emailBody: string): ReplyType {
  const lowerBody = emailBody.toLowerCase();

  // Check for questions
  if (lowerBody.includes('?')) {
    return 'acknowledgment';
  }

  // Check for scheduling mentions
  if (lowerBody.includes('meeting') || lowerBody.includes('call') || lowerBody.includes('schedule')) {
    return 'scheduling';
  }

  // Check for information sharing
  if (lowerBody.includes('wanted to share') || lowerBody.includes('let you know') || lowerBody.includes('fyi')) {
    return 'gratitude';
  }

  // Check for follow-up requests
  if (lowerBody.includes('thoughts') || lowerBody.includes('feedback') || lowerBody.includes('opinion')) {
    return 'positive';
  }

  // Random selection for variety
  const types: ReplyType[] = ['acknowledgment', 'question', 'follow_up', 'positive', 'gratitude'];
  return types[Math.floor(Math.random() * types.length)];
}

/**
 * Calculate spam score for generated reply
 */
function calculateReplySpamScore(body: string): number {
  let score = 0;
  const lowerBody = body.toLowerCase();

  // Check for spam patterns
  const spamPatterns = [
    { pattern: /\$\d+/, penalty: 10 },
    { pattern: /\b(free|discount|offer|deal|limited time)\b/i, penalty: 5 },
    { pattern: /\b(click here|act now|don't wait)\b/i, penalty: 10 },
    { pattern: /!{2,}/, penalty: 5 },
    { pattern: /\b(guaranteed|100%|amazing)\b/i, penalty: 3 },
    { pattern: /https?:\/\//i, penalty: 5 },
    { pattern: /ALL CAPS WORDS/g, penalty: 5 }
  ];

  for (const { pattern, penalty } of spamPatterns) {
    if (pattern.test(body)) {
      score += penalty;
    }
  }

  // Check for all caps words
  const words = body.split(/\s+/);
  const capsWords = words.filter(w => w.length > 3 && w === w.toUpperCase());
  score += capsWords.length * 2;

  // Excessive punctuation
  const exclamations = (body.match(/!/g) || []).length;
  if (exclamations > 2) {
    score += (exclamations - 2) * 2;
  }

  return Math.min(score, 100);
}

/**
 * Strip HTML from email body
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Template-based fallback for when AI is unavailable
 */
function templateFallback(options: ReplyOptions, startTime: number): GeneratedReply {
  const templates = getTemplatesByType(options.replyType || 'acknowledgment');
  const template = templates[Math.floor(Math.random() * templates.length)];

  // Simple variable replacement
  const body = template.body
    .replace(/\{sender\}/g, options.senderName)
    .replace(/\{recipient\}/g, options.recipientName);

  return {
    subject: generateReplySubject(options.originalSubject),
    body,
    replyType: options.replyType || 'acknowledgment',
    confidence: 0.7,
    spamScore: 5,
    metadata: {
      tokensUsed: 0,
      generationTime: Date.now() - startTime,
      model: 'template'
    }
  };
}

/**
 * Get templates by reply type
 */
function getTemplatesByType(type: ReplyType): TemplateReply[] {
  const templates: Record<ReplyType, TemplateReply[]> = {
    acknowledgment: [
      { subject: '', body: 'Thanks for sending this over. I appreciate you keeping me in the loop.', category: 'acknowledgment' },
      { subject: '', body: 'Got it, thanks for the update. I\'ll take a look when I get a chance.', category: 'acknowledgment' },
      { subject: '', body: 'Thanks for sharing this with me. Very helpful information.', category: 'acknowledgment' },
      { subject: '', body: 'Received, thank you! I\'ll review this shortly.', category: 'acknowledgment' }
    ],
    question: [
      { subject: '', body: 'Thanks for this. Quick question - what timeline are you thinking for this?', category: 'question' },
      { subject: '', body: 'Interesting points. Have you considered how this might impact the current process?', category: 'question' },
      { subject: '', body: 'Thanks for the update. Is there anything specific you need from my end?', category: 'question' },
      { subject: '', body: 'This is helpful. Do you have any additional context on the background?', category: 'question' }
    ],
    follow_up: [
      { subject: '', body: 'Building on what you mentioned, I\'ve been thinking about some related ideas that might be useful.', category: 'follow_up' },
      { subject: '', body: 'Good points. I wanted to add that we\'ve seen similar patterns in other areas as well.', category: 'follow_up' },
      { subject: '', body: 'Thanks for this. On a related note, there are a few other considerations worth exploring.', category: 'follow_up' }
    ],
    positive: [
      { subject: '', body: 'This looks great! Really appreciate you putting this together.', category: 'positive' },
      { subject: '', body: 'Excellent work on this. I think we\'re heading in the right direction.', category: 'positive' },
      { subject: '', body: 'Love it! This is exactly what we needed. Nice job.', category: 'positive' },
      { subject: '', body: 'This is really well done. I\'m impressed with the approach here.', category: 'positive' }
    ],
    scheduling: [
      { subject: '', body: 'Thanks for reaching out. I\'m generally available this week if you want to find a time to discuss.', category: 'scheduling' },
      { subject: '', body: 'Happy to chat about this. What does your calendar look like later this week?', category: 'scheduling' },
      { subject: '', body: 'Let me know what times work for you and we can set something up.', category: 'scheduling' }
    ],
    gratitude: [
      { subject: '', body: 'Really appreciate you sharing this. It\'s been very helpful for understanding the situation better.', category: 'gratitude' },
      { subject: '', body: 'Thank you for thinking of me and sending this along. Very useful information.', category: 'gratitude' },
      { subject: '', body: 'Thanks so much for this. I know you\'re busy, so I appreciate you taking the time.', category: 'gratitude' }
    ],
    continuation: [
      { subject: '', body: 'Following up on our conversation - I\'ve had a chance to think more about this.', category: 'continuation' },
      { subject: '', body: 'Wanted to circle back on this. Any updates on your end?', category: 'continuation' },
      { subject: '', body: 'Checking in on this. Let me know if there\'s anything else you need from me.', category: 'continuation' }
    ]
  };

  return templates[type] || templates.acknowledgment;
}

/**
 * Batch generate replies for multiple emails
 */
export async function batchGenerateReplies(
  emails: Array<{ id: string; subject: string; body: string; senderName: string }>,
  recipientName: string,
  options: Partial<ReplyOptions> = {}
): Promise<Map<string, GeneratedReply>> {
  const results = new Map<string, GeneratedReply>();

  // Process in parallel with concurrency limit
  const BATCH_SIZE = 5;

  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const batch = emails.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async (email) => {
        try {
          const reply = await generateAIReply({
            originalSubject: email.subject,
            originalBody: email.body,
            senderName: email.senderName,
            recipientName,
            ...options
          });
          return { id: email.id, reply };
        } catch (error) {
          console.error(`Failed to generate reply for email ${email.id}:`, error);
          return null;
        }
      })
    );

    for (const result of batchResults) {
      if (result) {
        results.set(result.id, result.reply);
      }
    }

    // Small delay between batches to avoid rate limiting
    if (i + BATCH_SIZE < emails.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  return results;
}

/**
 * Generate conversation thread
 */
export async function generateConversationThread(
  topic: string,
  participants: { name: string; email: string }[],
  threadLength: number = 4
): Promise<Array<{ from: string; to: string; subject: string; body: string }>> {
  const client = getAnthropicClient();
  const thread: Array<{ from: string; to: string; subject: string; body: string }> = [];

  // Generate initial email
  const initialPrompt = `Generate a professional email about: ${topic}

The email should be from ${participants[0].name} to ${participants[1].name}.
Make it natural and conversational, like a real business email.
Keep it under 100 words.
Only output the email body, no greeting or signature.`;

  try {
    const initialResponse = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: initialPrompt }]
    });

    const initialBody = extractReplyText(initialResponse);
    const subject = generateSubjectFromTopic(topic);

    thread.push({
      from: participants[0].email,
      to: participants[1].email,
      subject,
      body: initialBody
    });

    // Generate replies
    for (let i = 1; i < threadLength; i++) {
      const fromParticipant = participants[i % 2];
      const toParticipant = participants[(i + 1) % 2];

      const reply = await generateAIReply({
        originalSubject: subject,
        originalBody: thread[thread.length - 1].body,
        threadHistory: thread.slice(0, -1).map((msg, idx) => ({
          role: idx % 2 === 0 ? 'sent' : 'received' as const,
          content: msg.body
        })),
        senderName: toParticipant.name,
        recipientName: fromParticipant.name,
        replyType: i === threadLength - 1 ? 'acknowledgment' : 'continuation'
      });

      thread.push({
        from: fromParticipant.email,
        to: toParticipant.email,
        subject: reply.subject,
        body: reply.body
      });
    }

    return thread;
  } catch (error) {
    console.error('Failed to generate conversation thread:', error);
    return [];
  }
}

/**
 * Generate subject from topic
 */
function generateSubjectFromTopic(topic: string): string {
  // Simple subject generation from topic
  const words = topic.split(' ').slice(0, 6);
  return words.map((w, i) => i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w).join(' ');
}

/**
 * Store generated reply in database for analytics
 */
export async function storeGeneratedReply(
  emailId: string,
  reply: GeneratedReply
): Promise<void> {
  const supabase = await createClient();

  await supabase
    .from('warmup_reply_templates')
    .insert({
      category: reply.replyType,
      subject_template: reply.subject,
      body_template: reply.body,
      variables: [],
      usage_count: 1,
      effectiveness_score: reply.confidence * 100,
      metadata: {
        ai_generated: true,
        model: reply.metadata.model,
        spam_score: reply.spamScore
      }
    });
}

/**
 * Get effective reply templates from database
 */
export async function getEffectiveTemplates(
  category?: ReplyType,
  minEffectiveness: number = 70
): Promise<TemplateReply[]> {
  const supabase = await createClient();

  let query = supabase
    .from('warmup_reply_templates')
    .select('subject_template, body_template, category')
    .gte('effectiveness_score', minEffectiveness)
    .eq('is_active', true)
    .order('effectiveness_score', { ascending: false })
    .limit(20);

  if (category) {
    query = query.eq('category', category);
  }

  const { data, error } = await query;

  if (error || !data) {
    return [];
  }

  return data.map(t => ({
    subject: t.subject_template,
    body: t.body_template,
    category: t.category
  }));
}
