import Anthropic from '@anthropic-ai/sdk';
import { parseSpintax, countVariations } from '@/lib/spintax';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

export interface EmailGenerationRequest {
  companyName: string;
  recipientRole?: string;
  recipientIndustry?: string;
  valueProposition: string;
  tone: 'professional' | 'casual' | 'friendly' | 'direct';
  callToAction: string;
  senderName: string;
  senderCompany: string;
  additionalContext?: string;
}

export interface GeneratedEmail {
  subject: string;
  body: string;
  spintaxSubject: string;
  spintaxBody: string;
  variationCount: number;
  spamScore: number;
  tips: string[];
}

export interface EmailVariationSet {
  emails: GeneratedEmail[];
  metadata: {
    totalVariations: number;
    avgSpamScore: number;
    generatedAt: string;
  };
}

const EMAIL_WRITER_PROMPT = `You are an expert cold email copywriter who specializes in emails that land in the PRIMARY inbox, not spam or promotions.

CRITICAL RULES FOR DELIVERABILITY:
1. NO spam trigger words: "free", "guarantee", "limited time", "act now", "click here", "buy now", "discount", "offer", "deal"
2. NO excessive punctuation: !!!, ???, or ALL CAPS
3. NO more than ONE link per email (ideally zero in first email)
4. Keep subject lines under 50 characters, lowercase preferred
5. Write like a real human - include natural imperfections
6. Short paragraphs (2-3 sentences max)
7. Total email length: 50-125 words ideal
8. Include SPINTAX variations using {option1|option2|option3} syntax
9. Each variation should feel like a different email, not just word swaps

PERSONALIZATION HOOKS (use these variables):
{{first_name}} - recipient's first name
{{company}} - recipient's company
{{industry}} - their industry

OUTPUT FORMAT:
Return a JSON object with ONLY these fields:
{
  "subject": "The email subject line (no spintax)",
  "body": "The email body without spintax (plain version)",
  "spintaxSubject": "Subject {with|containing} spintax variations",
  "spintaxBody": "Email body {with|containing} multiple spintax {blocks|variations} for uniqueness",
  "tips": ["Tip 1", "Tip 2"]
}`;

export async function generateColdEmail(
  request: EmailGenerationRequest
): Promise<GeneratedEmail> {
  const userPrompt = `Generate a cold email with these specifications:

RECIPIENT:
- Company: ${request.companyName}
- Role: ${request.recipientRole || 'Decision maker'}
- Industry: ${request.recipientIndustry || 'Not specified'}

SENDER:
- Name: ${request.senderName}
- Company: ${request.senderCompany}

VALUE PROPOSITION:
${request.valueProposition}

DESIRED CALL TO ACTION:
${request.callToAction}

TONE: ${request.tone}

${request.additionalContext ? `ADDITIONAL CONTEXT:\n${request.additionalContext}` : ''}

Generate an email that:
1. Opens with a personalized observation (not "I hope this finds you well")
2. Quickly states the value (within first 2 sentences)
3. Includes social proof if natural
4. Ends with a soft CTA (question, not demand)
5. Has spintax for at least 50+ unique variations

Return ONLY valid JSON, no other text.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: EMAIL_WRITER_PROMPT + '\n\n' + userPrompt
      }
    ]
  });

  const content = response.content[0];
  if (!content || content.type !== 'text') {
    throw new Error('Unexpected response type');
  }

  // Parse JSON from response
  const jsonMatch = content.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse email JSON');
  }

  const parsed = JSON.parse(jsonMatch[0]);

  // Calculate variation count from spintax using our parser
  const spintaxBody = parsed.spintaxBody || parsed.body;
  const tokens = parseSpintax(spintaxBody);
  const variationCount = countVariations(tokens);

  // Calculate spam score
  const spamScore = calculateSpamScore(parsed.body || spintaxBody);

  return {
    subject: parsed.subject || '',
    body: parsed.body || '',
    spintaxSubject: parsed.spintaxSubject || parsed.subject || '',
    spintaxBody: spintaxBody,
    variationCount,
    spamScore,
    tips: parsed.tips || []
  };
}

export async function generateEmailVariations(
  request: EmailGenerationRequest,
  count: number = 5
): Promise<EmailVariationSet> {
  const emails: GeneratedEmail[] = [];
  const angles = [
    'Focus on a pain point they likely have',
    'Lead with a relevant industry trend or stat',
    'Reference a common challenge in their role',
    'Start with a genuine observation about their company',
    'Open with a thought-provoking question'
  ];

  // Generate multiple unique emails
  for (let i = 0; i < count; i++) {
    const email = await generateColdEmail({
      ...request,
      additionalContext: `${request.additionalContext || ''}\n\nThis is variation ${i + 1} of ${count}. ${angles[i % angles.length]}. Make it distinctly different from typical cold emails.`
    });
    emails.push(email);
  }

  const totalVariations = emails.reduce((sum, e) => sum + e.variationCount, 0);
  const avgSpamScore = emails.reduce((sum, e) => sum + e.spamScore, 0) / emails.length;

  return {
    emails,
    metadata: {
      totalVariations,
      avgSpamScore: Math.round(avgSpamScore),
      generatedAt: new Date().toISOString()
    }
  };
}

/**
 * Improve existing email for better deliverability
 */
export async function improveEmail(
  subject: string,
  body: string
): Promise<GeneratedEmail> {
  const prompt = `Improve this cold email for better deliverability. Keep the core message but:
1. Remove any spam trigger words
2. Add spintax variations for uniqueness
3. Make it more human and conversational
4. Shorten if over 125 words

ORIGINAL SUBJECT: ${subject}

ORIGINAL BODY:
${body}

Return ONLY valid JSON with these fields:
{
  "subject": "improved subject",
  "body": "improved body (plain)",
  "spintaxSubject": "subject {with|containing} spintax",
  "spintaxBody": "body {with|containing} spintax",
  "tips": ["What was fixed"]
}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: EMAIL_WRITER_PROMPT + '\n\n' + prompt
      }
    ]
  });

  const content = response.content[0];
  if (!content || content.type !== 'text') {
    throw new Error('Unexpected response type');
  }

  const jsonMatch = content.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse email JSON');
  }

  const parsed = JSON.parse(jsonMatch[0]);
  const spintaxBody = parsed.spintaxBody || parsed.body;
  const tokens = parseSpintax(spintaxBody);
  const variationCount = countVariations(tokens);
  const spamScore = calculateSpamScore(parsed.body || spintaxBody);

  return {
    subject: parsed.subject || '',
    body: parsed.body || '',
    spintaxSubject: parsed.spintaxSubject || parsed.subject || '',
    spintaxBody: spintaxBody,
    variationCount,
    spamScore,
    tips: parsed.tips || []
  };
}

function calculateSpamScore(text: string): number {
  let score = 100;

  const criticalTriggers = [
    'free', 'guarantee', 'winner', 'congratulations', 'act now',
    'limited time', 'urgent', 'immediate', 'expire', 'offer expires',
    'click here', 'click below', 'buy now', 'order now', 'sign up free',
    'no obligation', 'no cost', 'risk free', 'no strings attached',
    'double your', 'earn extra', 'make money', 'extra income'
  ];

  const warningTriggers = [
    'discount', 'deal', 'save', 'cheap', 'lowest price', 'best price',
    'special promotion', 'exclusive offer', 'limited offer', 'one time',
    'bonus', 'gift', 'prize', 'reward', 'cash', 'money back'
  ];

  const lowerText = text.toLowerCase();

  // Critical triggers: -15 each
  for (const trigger of criticalTriggers) {
    if (lowerText.includes(trigger)) {
      score -= 15;
    }
  }

  // Warning triggers: -8 each
  for (const trigger of warningTriggers) {
    if (lowerText.includes(trigger)) {
      score -= 8;
    }
  }

  // Check for excessive punctuation
  const exclamationCount = (text.match(/!/g) || []).length;
  if (exclamationCount > 1) score -= exclamationCount * 5;

  const questionCount = (text.match(/\?/g) || []).length;
  if (questionCount > 3) score -= (questionCount - 3) * 3;

  // Check for ALL CAPS words (4+ letters)
  const capsWords = text.match(/\b[A-Z]{4,}\b/g) || [];
  score -= capsWords.length * 5;

  // Check length
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
  if (wordCount > 200) score -= 15;
  if (wordCount > 300) score -= 15;
  if (wordCount < 20) score -= 10;

  // Check for multiple links
  const linkCount = (text.match(/https?:\/\//g) || []).length;
  if (linkCount > 1) score -= (linkCount - 1) * 15;

  // Check for URL shorteners
  if (/bit\.ly|goo\.gl|tinyurl|t\.co/i.test(text)) {
    score -= 15;
  }

  return Math.max(0, Math.min(100, score));
}

export { calculateSpamScore };
