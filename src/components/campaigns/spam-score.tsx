'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  AlertTriangle,
  CheckCircle,
  XCircle,
  Info,
  Clock,
  Link,
  FileText,
  Loader2
} from 'lucide-react';
import { useDebounce } from '@/hooks/use-debounce';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronUp } from 'lucide-react';

interface SpamScoreProps {
  subject: string;
  content: string;
  showDetails?: boolean;
}

interface SpamIssue {
  type: 'critical' | 'warning' | 'caution' | 'pattern';
  text: string;
  penalty: number;
  suggestion: string;
  count?: number;
}

interface SpamResult {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  issues: SpamIssue[];
  suggestions: string[];
  wordCount: number;
  linkCount: number;
  readableInSeconds: number;
  summary: string;
}

export function SpamScore({ subject, content, showDetails = true }: SpamScoreProps) {
  const [result, setResult] = useState<SpamResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const debouncedSubject = useDebounce(subject, 500);
  const debouncedContent = useDebounce(content, 500);

  useEffect(() => {
    if (!debouncedContent) {
      setResult(null);
      return;
    }

    const analyze = async () => {
      setLoading(true);
      try {
        const response = await fetch('/api/spam-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subject: debouncedSubject,
            content: debouncedContent
          })
        });

        if (response.ok) {
          const data = await response.json();
          setResult(data);
        }
      } catch (error) {
        console.error('Spam check failed:', error);
      } finally {
        setLoading(false);
      }
    };

    analyze();
  }, [debouncedSubject, debouncedContent]);

  if (!result && !loading) return null;

  const getGradeColor = (grade: string) => {
    switch (grade) {
      case 'A': return 'bg-green-500';
      case 'B': return 'bg-green-400';
      case 'C': return 'bg-yellow-500';
      case 'D': return 'bg-orange-500';
      case 'F': return 'bg-red-500';
      default: return 'bg-gray-500';
    }
  };

  const getScoreColor = (score: number) => {
    if (score >= 90) return 'text-green-500';
    if (score >= 80) return 'text-green-400';
    if (score >= 70) return 'text-yellow-500';
    if (score >= 60) return 'text-orange-500';
    return 'text-red-500';
  };

  const getProgressColor = (score: number) => {
    if (score >= 90) return 'bg-green-500';
    if (score >= 80) return 'bg-green-400';
    if (score >= 70) return 'bg-yellow-500';
    if (score >= 60) return 'bg-orange-500';
    return 'bg-red-500';
  };

  const criticalIssues = result?.issues.filter(i => i.type === 'critical') || [];
  const warningIssues = result?.issues.filter(i => i.type === 'warning') || [];

  return (
    <Card className="border-l-4" style={{
      borderLeftColor: result ? (result.score >= 80 ? '#22c55e' : result.score >= 60 ? '#f59e0b' : '#ef4444') : '#6b7280'
    }}>
      <CardHeader className="py-3">
        <CardTitle className="text-sm font-medium flex items-center justify-between">
          <span className="flex items-center gap-2">
            Spam Score
            {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          </span>
          {result && (
            <div className="flex items-center gap-2">
              <span className={`text-2xl font-bold ${getScoreColor(result.score)}`}>
                {result.score}
              </span>
              <Badge className={`${getGradeColor(result.grade)} text-white`}>
                {result.grade}
              </Badge>
            </div>
          )}
        </CardTitle>
      </CardHeader>

      {result && (
        <CardContent className="py-3 space-y-4">
          {/* Progress bar */}
          <div className="space-y-2">
            <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full ${getProgressColor(result.score)} transition-all duration-500`}
                style={{ width: `${result.score}%` }}
              />
            </div>
            <p className="text-sm text-muted-foreground">{result.summary}</p>
          </div>

          {/* Stats */}
          <div className="flex gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <FileText className="h-3 w-3" />
              {result.wordCount} words
            </span>
            <span className="flex items-center gap-1">
              <Link className="h-3 w-3" />
              {result.linkCount} link{result.linkCount !== 1 ? 's' : ''}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              ~{result.readableInSeconds}s read
            </span>
          </div>

          {/* Quick status */}
          {result.score >= 80 && criticalIssues.length === 0 && (
            <div className="flex items-center gap-2 text-green-500 text-sm">
              <CheckCircle className="h-4 w-4" />
              Good deliverability expected
            </div>
          )}

          {showDetails && (criticalIssues.length > 0 || warningIssues.length > 0) && (
            <Collapsible open={expanded} onOpenChange={setExpanded}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="w-full justify-between p-2 h-auto">
                  <span className="flex items-center gap-2 text-sm">
                    {criticalIssues.length > 0 && (
                      <Badge variant="destructive" className="text-xs">
                        {criticalIssues.length} Critical
                      </Badge>
                    )}
                    {warningIssues.length > 0 && (
                      <Badge variant="outline" className="text-xs border-yellow-500 text-yellow-600">
                        {warningIssues.length} Warnings
                      </Badge>
                    )}
                  </span>
                  {expanded ? (
                    <ChevronUp className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                </Button>
              </CollapsibleTrigger>

              <CollapsibleContent className="space-y-3 mt-2">
                {/* Critical Issues */}
                {criticalIssues.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-red-500 text-sm font-medium">
                      <XCircle className="h-4 w-4" />
                      Critical Issues
                    </div>
                    {criticalIssues.map((issue, i) => (
                      <div key={i} className="text-sm p-2 bg-red-50 dark:bg-red-950/30 rounded border border-red-200 dark:border-red-800">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-medium text-red-700 dark:text-red-300">
                            {issue.text}
                          </span>
                          <span className="text-xs text-red-600 dark:text-red-400">
                            -{issue.penalty} points
                          </span>
                        </div>
                        <span className="text-red-600 dark:text-red-400 text-xs">
                          {issue.suggestion}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Warnings */}
                {warningIssues.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-yellow-600 text-sm font-medium">
                      <AlertTriangle className="h-4 w-4" />
                      Warnings
                    </div>
                    {warningIssues.slice(0, 5).map((issue, i) => (
                      <div key={i} className="text-sm p-2 bg-yellow-50 dark:bg-yellow-950/30 rounded border border-yellow-200 dark:border-yellow-800">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-medium text-yellow-700 dark:text-yellow-300">
                            {issue.text}
                          </span>
                          <span className="text-xs text-yellow-600 dark:text-yellow-400">
                            -{issue.penalty} points
                          </span>
                        </div>
                        <span className="text-yellow-600 dark:text-yellow-400 text-xs">
                          {issue.suggestion}
                        </span>
                      </div>
                    ))}
                    {warningIssues.length > 5 && (
                      <div className="text-sm text-muted-foreground">
                        +{warningIssues.length - 5} more warnings
                      </div>
                    )}
                  </div>
                )}
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* Suggestions */}
          {result.suggestions.length > 0 && result.score < 90 && (
            <div className="space-y-1 pt-2 border-t">
              {result.suggestions.slice(0, 2).map((suggestion, i) => (
                <div key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
                  {suggestion}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// Compact inline version
export function SpamScoreInline({ subject, content }: { subject: string; content: string }) {
  const [result, setResult] = useState<{ score: number; grade: string } | null>(null);
  const debouncedContent = useDebounce(content, 500);

  useEffect(() => {
    if (!debouncedContent) return;

    let cancelled = false;

    const analyze = async () => {
      try {
        const response = await fetch('/api/spam-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subject,
            content: debouncedContent,
            action: 'check'
          })
        });

        if (response.ok) {
          const data = await response.json();
          // Ignore a response that lost the race to a newer request.
          if (!cancelled) setResult({ score: data.score, grade: data.grade });
        }
      } catch (error) {
        console.error('Spam check failed:', error);
      }
    };

    analyze();

    return () => {
      cancelled = true;
    };
  }, [subject, debouncedContent]);

  // Derived during render rather than written back in the effect: empty content
  // simply has no score, and the last score never flashes against new content.
  const current = debouncedContent ? result : null;

  if (current === null) return null;

  const getColor = (s: number) => {
    if (s >= 80) return 'bg-green-500';
    if (s >= 60) return 'bg-yellow-500';
    return 'bg-red-500';
  };

  return (
    <Badge className={`${getColor(current.score)} text-white`}>
      {current.grade} ({current.score}/100)
    </Badge>
  );
}
