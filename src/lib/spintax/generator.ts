import { parseSpintax, SpintaxToken, SpintaxResult } from './parser';
import { createHash } from 'crypto';

/**
 * Count total possible variations
 */
export function countVariations(tokens: SpintaxToken[]): number {
  let count = 1;

  for (const token of tokens) {
    if (token.type === 'spin' && token.options) {
      let optionCount = 0;
      for (const option of token.options) {
        optionCount += countVariations(option);
      }
      count *= optionCount;
    }
  }

  return count;
}

/**
 * Count variations from raw spintax string
 */
export function countVariationsFromString(input: string): number {
  const tokens = parseSpintax(input);
  return countVariations(tokens);
}

/**
 * Generate a specific variation by index
 */
export function generateVariation(tokens: SpintaxToken[], index: number): string {
  let result = '';
  let currentIndex = index;

  for (const token of tokens) {
    if (token.type === 'text') {
      result += token.value;
    } else if (token.type === 'spin' && token.options) {
      // Calculate which option to use
      const optionCounts = token.options.map(opt => countVariations(opt));
      const totalOptions = optionCounts.reduce((a, b) => a + b, 0);

      const optionIndex = currentIndex % totalOptions;
      currentIndex = Math.floor(currentIndex / totalOptions);

      // Find which option this index falls into
      let accumulated = 0;
      for (let i = 0; i < token.options.length; i++) {
        if (optionIndex < accumulated + optionCounts[i]) {
          const subIndex = optionIndex - accumulated;
          result += generateVariation(token.options[i], subIndex);
          break;
        }
        accumulated += optionCounts[i];
      }
    }
  }

  return result;
}

/**
 * Generate a random variation
 */
export function generateRandomVariation(input: string): SpintaxResult {
  const tokens = parseSpintax(input);
  const totalVariations = countVariations(tokens);
  const variationIndex = Math.floor(Math.random() * totalVariations);
  const text = generateVariation(tokens, variationIndex);
  const hash = createHash('md5').update(text).digest('hex').slice(0, 8);

  return { text, hash, variationIndex };
}

/**
 * Generate unique variation for a recipient (deterministic)
 * Same recipient + campaign always gets the same variation
 */
export function generateUniqueVariation(
  input: string,
  recipientEmail: string,
  campaignId: string
): SpintaxResult {
  const tokens = parseSpintax(input);
  const totalVariations = countVariations(tokens);

  // Create deterministic index from recipient + campaign
  const seed = createHash('md5')
    .update(`${recipientEmail}:${campaignId}`)
    .digest();

  const seedNumber = seed.readUInt32BE(0);
  const variationIndex = seedNumber % totalVariations;
  const text = generateVariation(tokens, variationIndex);
  const hash = createHash('md5').update(text).digest('hex').slice(0, 8);

  return { text, hash, variationIndex };
}

/**
 * Check if two recipients would get the same variation
 */
export function wouldCollide(
  input: string,
  email1: string,
  email2: string,
  campaignId: string
): boolean {
  const v1 = generateUniqueVariation(input, email1, campaignId);
  const v2 = generateUniqueVariation(input, email2, campaignId);
  return v1.hash === v2.hash;
}

/**
 * Calculate collision probability for a given number of recipients
 */
export function calculateCollisionProbability(
  input: string,
  recipientCount: number
): { probability: number; recommendation: string } {
  const tokens = parseSpintax(input);
  const totalVariations = countVariations(tokens);

  if (totalVariations >= recipientCount) {
    return {
      probability: 0,
      recommendation: 'Each recipient can receive a unique variation'
    };
  }

  // Birthday paradox approximation
  const probability = 1 - Math.exp(-(recipientCount * (recipientCount - 1)) / (2 * totalVariations));

  let recommendation: string;
  if (probability < 0.01) {
    recommendation = 'Low collision risk';
  } else if (probability < 0.1) {
    recommendation = 'Some recipients may receive identical emails. Consider adding more spintax.';
  } else {
    recommendation = 'High collision risk! Add more spintax variations to ensure uniqueness.';
  }

  return { probability, recommendation };
}

/**
 * Generate all variations (for preview, limit to max)
 */
export function generateAllVariations(input: string, limit = 100): SpintaxResult[] {
  const tokens = parseSpintax(input);
  const total = countVariations(tokens);
  const results: SpintaxResult[] = [];

  const count = Math.min(total, limit);
  for (let i = 0; i < count; i++) {
    const text = generateVariation(tokens, i);
    const hash = createHash('md5').update(text).digest('hex').slice(0, 8);
    results.push({ text, hash, variationIndex: i });
  }

  return results;
}

/**
 * Apply personalization variables to spintax output
 */
export function applyPersonalization(
  text: string,
  variables: Record<string, string>
): string {
  let result = text;

  for (const [key, value] of Object.entries(variables)) {
    // Support both {{var}} and {var} syntax
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }

  return result;
}

/**
 * Generate email for a specific recipient with full processing
 */
export function generateEmailForRecipient(
  subjectSpintax: string,
  bodySpintax: string,
  recipientEmail: string,
  campaignId: string,
  variables: Record<string, string> = {}
): { subject: string; body: string; variationHash: string } {
  // Generate unique variations
  const subjectResult = generateUniqueVariation(subjectSpintax, recipientEmail, campaignId);
  const bodyResult = generateUniqueVariation(bodySpintax, recipientEmail, `${campaignId}-body`);

  // Apply personalization
  const subject = applyPersonalization(subjectResult.text, variables);
  const body = applyPersonalization(bodyResult.text, variables);

  // Combined hash for tracking
  const variationHash = createHash('md5')
    .update(`${subjectResult.hash}:${bodyResult.hash}`)
    .digest('hex')
    .slice(0, 12);

  return { subject, body, variationHash };
}
