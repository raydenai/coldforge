'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Shuffle,
  Copy,
  Check,
  AlertCircle,
  Zap,
} from 'lucide-react';
import { useDebounce } from '@/hooks/use-debounce';

interface SpintaxEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  showVariationCount?: boolean;
  showPreview?: boolean;
}

interface SpintaxStats {
  valid: boolean;
  variationCount: number;
  spintaxBlocks: number;
  error?: string;
}

interface SpintaxPreview {
  text: string;
  hash: string;
  variationIndex: number;
}

export function SpintaxEditor({
  value,
  onChange,
  placeholder = 'Enter text with spintax...',
  label,
  showVariationCount = true,
  showPreview = true
}: SpintaxEditorProps) {
  const [stats, setStats] = useState<SpintaxStats | null>(null);
  const [preview, setPreview] = useState<SpintaxPreview | null>(null);
  const [allVariations, setAllVariations] = useState<SpintaxPreview[]>([]);
  const [, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState('edit');

  const debouncedValue = useDebounce(value, 300);

  // Validate and get stats
  useEffect(() => {
    if (!debouncedValue) {
      setStats(null);
      setPreview(null);
      return;
    }

    const validate = async () => {
      setLoading(true);
      try {
        const response = await fetch('/api/spintax', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: debouncedValue, action: 'validate' })
        });

        if (response.ok) {
          const data = await response.json();
          setStats({
            valid: true,
            variationCount: data.variationCount,
            spintaxBlocks: data.spintaxBlocks
          });
        } else {
          const error = await response.json();
          setStats({
            valid: false,
            variationCount: 0,
            spintaxBlocks: 0,
            error: error.details || error.error
          });
        }
      } catch (error) {
        console.error('Validation failed:', error);
      } finally {
        setLoading(false);
      }
    };

    validate();
  }, [debouncedValue]);

  // Generate preview
  const generatePreview = useCallback(async () => {
    if (!value) return;

    try {
      const response = await fetch('/api/spintax', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: value, action: 'preview' })
      });

      if (response.ok) {
        const data = await response.json();
        setPreview(data);
      }
    } catch (error) {
      console.error('Preview generation failed:', error);
    }
  }, [value]);

  // Load all variations
  const loadAllVariations = useCallback(async () => {
    if (!value) return;

    try {
      const response = await fetch('/api/spintax', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: value, action: 'all', limit: 50 })
      });

      if (response.ok) {
        const data = await response.json();
        setAllVariations(data.variations);
      }
    } catch (error) {
      console.error('Loading variations failed:', error);
    }
  }, [value]);

  // Auto-generate preview when valid
  useEffect(() => {
    if (stats?.valid && showPreview) {
      generatePreview();
    }
  }, [stats?.valid, showPreview, generatePreview]);

  // Load variations when switching to variations tab
  useEffect(() => {
    if (activeTab === 'variations' && stats?.valid) {
      loadAllVariations();
    }
  }, [activeTab, stats?.valid, loadAllVariations]);

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Insert spintax helper
  const insertSpintax = (template: string) => {
    const textarea = document.querySelector('textarea[data-spintax-editor]') as HTMLTextAreaElement;
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newValue = value.slice(0, start) + template + value.slice(end);
      onChange(newValue);
      // Reset cursor position
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(start + template.length, start + template.length);
      }, 0);
    } else {
      onChange(value + template);
    }
  };

  const spintaxTemplates = [
    { label: 'Greeting', template: '{Hi|Hello|Hey}' },
    { label: 'Name Intro', template: '{I\'m|My name is|This is}' },
    { label: 'Question', template: '{Do you|Would you|Could you}' },
    { label: 'CTA', template: '{Let me know|Get back to me|Reply here}' },
  ];

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-sm font-medium flex items-center justify-between">
          <span>{label || 'Spintax Editor'}</span>
          {showVariationCount && stats && (
            <div className="flex items-center gap-2">
              {stats.valid ? (
                <>
                  <Badge variant="secondary" className="font-normal">
                    <Zap className="h-3 w-3 mr-1" />
                    {stats.variationCount.toLocaleString()} variations
                  </Badge>
                  {stats.spintaxBlocks > 0 && (
                    <Badge variant="outline" className="font-normal">
                      {stats.spintaxBlocks} spin blocks
                    </Badge>
                  )}
                </>
              ) : (
                <Badge variant="destructive" className="font-normal">
                  <AlertCircle className="h-3 w-3 mr-1" />
                  Invalid syntax
                </Badge>
              )}
            </div>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="edit">Edit</TabsTrigger>
            <TabsTrigger value="preview" disabled={!stats?.valid}>
              Preview
            </TabsTrigger>
            <TabsTrigger value="variations" disabled={!stats?.valid}>
              All Variations
            </TabsTrigger>
          </TabsList>

          <TabsContent value="edit" className="space-y-3">
            {/* Quick insert buttons */}
            <div className="flex flex-wrap gap-2">
              <span className="text-xs text-muted-foreground">Quick insert:</span>
              {spintaxTemplates.map((t) => (
                <Button
                  key={t.label}
                  variant="outline"
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => insertSpintax(t.template)}
                >
                  {t.label}
                </Button>
              ))}
            </div>

            <Textarea
              data-spintax-editor
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={placeholder}
              className="min-h-[150px] font-mono text-sm"
            />

            {stats?.error && (
              <div className="text-sm text-destructive flex items-center gap-2">
                <AlertCircle className="h-4 w-4" />
                {stats.error}
              </div>
            )}

            <div className="text-xs text-muted-foreground">
              <p>
                <strong>Syntax:</strong> Use {'{option1|option2|option3}'} for variations.
                Nesting supported: {'{Hi|Hello {friend|colleague}}'}.
              </p>
            </div>
          </TabsContent>

          <TabsContent value="preview" className="space-y-3">
            {preview && (
              <div className="space-y-3">
                <div className="p-4 bg-muted rounded-lg">
                  <p className="whitespace-pre-wrap">{preview.text}</p>
                </div>

                <div className="flex items-center justify-between">
                  <div className="text-xs text-muted-foreground">
                    Variation #{preview.variationIndex + 1} • Hash: {preview.hash}
                  </div>
                  <div className="flex gap-2">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => copyToClipboard(preview.text)}
                          >
                            {copied ? (
                              <Check className="h-4 w-4" />
                            ) : (
                              <Copy className="h-4 w-4" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Copy to clipboard</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>

                    <Button variant="outline" size="sm" onClick={generatePreview}>
                      <Shuffle className="h-4 w-4 mr-2" />
                      Shuffle
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="variations" className="space-y-3">
            <div className="text-sm text-muted-foreground mb-2">
              Showing {allVariations.length} of {stats?.variationCount.toLocaleString()} variations
            </div>

            <div className="max-h-[300px] overflow-y-auto space-y-2">
              {allVariations.map((variation, index) => (
                <div
                  key={variation.hash}
                  className="p-3 bg-muted rounded-lg text-sm flex items-start justify-between gap-2"
                >
                  <div className="flex-1">
                    <span className="text-muted-foreground mr-2">#{index + 1}</span>
                    {variation.text}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 flex-shrink-0"
                    onClick={() => copyToClipboard(variation.text)}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>

            {stats && stats.variationCount > 50 && (
              <p className="text-xs text-muted-foreground text-center">
                {(stats.variationCount - 50).toLocaleString()} more variations available
              </p>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

// Export a simpler inline version for forms
export function SpintaxInput({
  value,
  onChange,
  placeholder
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [count, setCount] = useState<number | null>(null);
  const debouncedValue = useDebounce(value, 500);
  const hasSpintax = Boolean(debouncedValue) && debouncedValue.includes('{');

  useEffect(() => {
    if (!hasSpintax) return;

    let cancelled = false;

    const validate = async () => {
      try {
        const response = await fetch('/api/spintax', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: debouncedValue, action: 'count' })
        });

        if (response.ok) {
          const data = await response.json();
          // Ignore a response that lost the race to a newer request.
          if (!cancelled) setCount(data.count);
        }
      } catch (error) {
        console.error('Count failed:', error);
      }
    };

    validate();

    return () => {
      cancelled = true;
    };
  }, [debouncedValue, hasSpintax]);

  // Derived during render rather than written back in the effect, so the badge
  // never shows a stale count for text that no longer contains spintax.
  const variationCount = hasSpintax ? count : null;

  return (
    <div className="relative">
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-h-[100px] font-mono text-sm pr-20"
      />
      {variationCount !== null && variationCount > 1 && (
        <Badge
          variant="secondary"
          className="absolute top-2 right-2 text-xs"
        >
          {variationCount.toLocaleString()} vars
        </Badge>
      )}
    </div>
  );
}
