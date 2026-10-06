import { SPAM_TRIGGERS, SPAM_PATTERNS, SpamCheckResult, SpamIssue } from './spam-words';

/**
 * Analyze email content for spam triggers
 */
export function analyzeContent(subject: string, body: string): SpamCheckResult {
  const fullText = `${subject} ${body}`;
  const issues: SpamIssue[] = [];
  let penalty = 0;

  // Check spam trigger words by severity
  for (const word of SPAM_TRIGGERS.critical) {
    const lowerWord = word.toLowerCase();
    const regex = new RegExp(`\\b${lowerWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    const matches = fullText.match(regex);
    if (matches) {
      penalty += 15 * matches.length;
      issues.push({
        type: 'critical',
        text: word,
        penalty: 15 * matches.length,
        suggestion: `Remove or rephrase "${word}" - high spam risk`,
        count: matches.length
      });
    }
  }

  for (const word of SPAM_TRIGGERS.warning) {
    const lowerWord = word.toLowerCase();
    const regex = new RegExp(`\\b${lowerWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    const matches = fullText.match(regex);
    if (matches) {
      penalty += 8 * matches.length;
      issues.push({
        type: 'warning',
        text: word,
        penalty: 8 * matches.length,
        suggestion: `Consider removing "${word}"`,
        count: matches.length
      });
    }
  }

  for (const word of SPAM_TRIGGERS.caution) {
    const lowerWord = word.toLowerCase();
    const regex = new RegExp(`\\b${lowerWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    const matches = fullText.match(regex);
    if (matches) {
      penalty += 3 * matches.length;
      issues.push({
        type: 'caution',
        text: word,
        penalty: 3 * matches.length,
        suggestion: `"${word}" may trigger spam filters if overused`,
        count: matches.length
      });
    }
  }

  // Check patterns
  for (const [name, config] of Object.entries(SPAM_PATTERNS)) {
    const matches = fullText.match(config.pattern);
    if (matches) {
      const count = matches.length;
      // For links, only penalize if more than 1
      if (name === 'multipleLinks' && count <= 1) continue;

      const totalPenalty = config.penalty * (name === 'multipleLinks' ? count - 1 : count);
      penalty += totalPenalty;
      issues.push({
        type: 'pattern',
        text: `${count}x ${config.description}`,
        penalty: totalPenalty,
        suggestion: config.suggestion,
        count
      });
    }
  }

  // Check content structure
  const wordCount = body.split(/\s+/).filter(w => w.length > 0).length;
  const linkCount = (body.match(/https?:\/\//g) || []).length;

  // Penalize too long or too short
  if (wordCount > 300) {
    const overPenalty = Math.min(25, Math.floor((wordCount - 300) / 50) * 5);
    penalty += overPenalty;
    issues.push({
      type: 'warning',
      text: `${wordCount} words (too long)`,
      penalty: overPenalty,
      suggestion: 'Keep cold emails under 150 words for best results. Aim for 50-125 words.'
    });
  } else if (wordCount > 200) {
    penalty += 10;
    issues.push({
      type: 'caution',
      text: `${wordCount} words`,
      penalty: 10,
      suggestion: 'Consider shortening. Best cold emails are 50-125 words.'
    });
  } else if (wordCount < 20) {
    penalty += 10;
    issues.push({
      type: 'warning',
      text: 'Too short',
      penalty: 10,
      suggestion: 'Add more context - very short emails look suspicious'
    });
  }

  // Penalize multiple links heavily
  if (linkCount > 1) {
    const linkPenalty = (linkCount - 1) * 15;
    penalty += linkPenalty;
    issues.push({
      type: 'critical',
      text: `${linkCount} links`,
      penalty: linkPenalty,
      suggestion: 'Use only 1 link maximum, preferably none in first email'
    });
  }

  // Check subject line
  if (subject.length > 60) {
    penalty += 5;
    issues.push({
      type: 'caution',
      text: 'Subject line too long',
      penalty: 5,
      suggestion: 'Keep subject under 50 characters for better open rates'
    });
  }

  if (subject === subject.toUpperCase() && subject.length > 5) {
    penalty += 15;
    issues.push({
      type: 'critical',
      text: 'ALL CAPS subject line',
      penalty: 15,
      suggestion: 'Use sentence case in subject line'
    });
  }

  // Check for personalization variables (good thing)
  const hasPersonalization = /\{\{[^}]+\}\}/.test(fullText);
  if (hasPersonalization) {
    penalty -= 5; // Bonus for personalization
  }

  // Calculate final score
  const score = Math.max(0, Math.min(100, 100 - penalty));

  // Determine grade
  let grade: 'A' | 'B' | 'C' | 'D' | 'F';
  if (score >= 90) grade = 'A';
  else if (score >= 80) grade = 'B';
  else if (score >= 70) grade = 'C';
  else if (score >= 60) grade = 'D';
  else grade = 'F';

  // Generate suggestions
  const suggestions = generateSuggestions(issues, score, wordCount, linkCount);

  // Generate summary
  const summary = generateSummary(score, grade, issues);

  return {
    score,
    grade,
    issues: issues.sort((a, b) => b.penalty - a.penalty),
    suggestions,
    wordCount,
    linkCount,
    readableInSeconds: Math.ceil(wordCount / 3.5), // Average reading speed
    summary
  };
}

function generateSuggestions(
  issues: SpamIssue[],
  score: number,
  wordCount: number,
  linkCount: number
): string[] {
  const suggestions: string[] = [];

  const critical = issues.filter(i => i.type === 'critical');
  const warnings = issues.filter(i => i.type === 'warning');

  if (critical.length > 0) {
    suggestions.push(`Fix ${critical.length} critical issue(s) first - these are likely to trigger spam filters`);
  }

  if (warnings.length > 3) {
    suggestions.push('Rewrite with simpler, more conversational language');
  }

  if (wordCount > 150) {
    suggestions.push(`Shorten to 50-125 words. Current: ${wordCount} words`);
  }

  if (linkCount > 0) {
    suggestions.push('Consider removing links from first email - builds trust before asking for action');
  }

  if (score < 70) {
    suggestions.push('Use the AI Email Writer for better deliverability');
  }

  if (score >= 80 && score < 90) {
    suggestions.push('Good! Minor improvements could boost inbox placement');
  }

  if (score >= 90) {
    suggestions.push('Excellent! This email should have good deliverability');
  }

  return suggestions;
}

function generateSummary(
  score: number,
  _grade: string,
  issues: SpamIssue[]
): string {
  const critical = issues.filter(i => i.type === 'critical').length;
  const warnings = issues.filter(i => i.type === 'warning').length;

  if (score >= 90) {
    return 'Your email looks great and should land in the primary inbox.';
  }
  if (score >= 80) {
    return `Good email with minor issues. ${warnings > 0 ? `Fix ${warnings} warning(s) to improve.` : ''}`;
  }
  if (score >= 70) {
    return `Decent email but needs work. ${critical > 0 ? `${critical} critical issue(s) found.` : ''}`;
  }
  if (score >= 60) {
    return `This email may land in spam. ${critical} critical and ${warnings} warning issues found.`;
  }
  return `High spam risk! This email will likely be filtered. Major rewrite needed.`;
}

/**
 * Quick check - returns just the score
 */
export function quickCheck(content: string): number {
  const result = analyzeContent('', content);
  return result.score;
}

/**
 * Check if content passes minimum threshold
 */
export function passesThreshold(
  subject: string,
  body: string,
  minScore: number = 70
): boolean {
  const result = analyzeContent(subject, body);
  return result.score >= minScore;
}

/**
 * Get issues by severity
 */
export function getIssuesBySeverity(
  subject: string,
  body: string
): {
  critical: SpamIssue[];
  warning: SpamIssue[];
  caution: SpamIssue[];
} {
  const result = analyzeContent(subject, body);
  return {
    critical: result.issues.filter(i => i.type === 'critical'),
    warning: result.issues.filter(i => i.type === 'warning'),
    caution: result.issues.filter(i => i.type === 'caution' || i.type === 'pattern')
  };
}
