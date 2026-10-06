'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Sparkles, Loader2, Copy, Check, AlertTriangle, Wand2 } from 'lucide-react';
import { toast } from 'sonner';

interface GeneratedEmail {
  subject: string;
  body: string;
  spintaxSubject: string;
  spintaxBody: string;
  variationCount: number;
  spamScore: number;
  tips: string[];
}

interface AIEmailWriterProps {
  onSelect?: (subject: string, body: string) => void;
  senderName?: string;
  senderCompany?: string;
}

export function AIEmailWriter({ onSelect, senderName = '', senderCompany = '' }: AIEmailWriterProps) {
  const [loading, setLoading] = useState(false);
  const [emails, setEmails] = useState<GeneratedEmail[]>([]);
  const [copied, setCopied] = useState<number | null>(null);
  const [selectedTab, setSelectedTab] = useState('0');

  const [form, setForm] = useState({
    companyName: '',
    recipientRole: '',
    recipientIndustry: '',
    valueProposition: '',
    tone: 'professional',
    callToAction: '',
    senderName,
    senderCompany,
    additionalContext: ''
  });

  const handleGenerate = async () => {
    if (!form.companyName || !form.valueProposition || !form.callToAction) {
      toast.error('Please fill in required fields');
      return;
    }

    if (!form.senderName || !form.senderCompany) {
      toast.error('Please fill in sender name and company');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/ai/email-writer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          generateMultiple: true,
          variationCount: 5
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to generate');
      }

      const data = await response.json();
      setEmails(data.emails);
      setSelectedTab('0');
      toast.success(`Generated ${data.emails.length} email variations with ${data.metadata.totalVariations.toLocaleString()} total variations`);

    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to generate emails');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async (email: GeneratedEmail, index: number) => {
    await navigator.clipboard.writeText(`Subject: ${email.spintaxSubject}\n\n${email.spintaxBody}`);
    setCopied(index);
    setTimeout(() => setCopied(null), 2000);
    toast.success('Copied to clipboard');
  };

  const handleUse = (email: GeneratedEmail) => {
    if (onSelect) {
      onSelect(email.spintaxSubject, email.spintaxBody);
      toast.success('Email copied to editor');
    }
  };

  const getSpamScoreColor = (score: number) => {
    if (score >= 80) return 'bg-green-500';
    if (score >= 60) return 'bg-yellow-500';
    return 'bg-red-500';
  };

  const getSpamScoreLabel = (score: number) => {
    if (score >= 90) return 'Excellent';
    if (score >= 80) return 'Good';
    if (score >= 70) return 'Fair';
    if (score >= 60) return 'Needs Work';
    return 'High Risk';
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            AI Email Writer
          </CardTitle>
          <CardDescription>
            Generate unique, deliverability-optimized cold emails with Claude AI.
            Each generation creates 5 different email versions with built-in spintax for thousands of variations.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Target Company *</Label>
              <Input
                value={form.companyName}
                onChange={e => setForm({ ...form, companyName: e.target.value })}
                placeholder="e.g., Acme Corp"
              />
            </div>
            <div className="space-y-2">
              <Label>Recipient Role</Label>
              <Input
                value={form.recipientRole}
                onChange={e => setForm({ ...form, recipientRole: e.target.value })}
                placeholder="e.g., Marketing Director"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Industry</Label>
              <Input
                value={form.recipientIndustry}
                onChange={e => setForm({ ...form, recipientIndustry: e.target.value })}
                placeholder="e.g., SaaS, E-commerce"
              />
            </div>
            <div className="space-y-2">
              <Label>Tone</Label>
              <Select value={form.tone} onValueChange={v => setForm({ ...form, tone: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="professional">Professional</SelectItem>
                  <SelectItem value="casual">Casual</SelectItem>
                  <SelectItem value="friendly">Friendly</SelectItem>
                  <SelectItem value="direct">Direct</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Your Name *</Label>
              <Input
                value={form.senderName}
                onChange={e => setForm({ ...form, senderName: e.target.value })}
                placeholder="e.g., John Doe"
              />
            </div>
            <div className="space-y-2">
              <Label>Your Company *</Label>
              <Input
                value={form.senderCompany}
                onChange={e => setForm({ ...form, senderCompany: e.target.value })}
                placeholder="e.g., Acme Solutions"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Value Proposition *</Label>
            <Textarea
              value={form.valueProposition}
              onChange={e => setForm({ ...form, valueProposition: e.target.value })}
              placeholder="What value do you offer? What problem do you solve? Be specific about results or benefits."
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label>Call to Action *</Label>
            <Input
              value={form.callToAction}
              onChange={e => setForm({ ...form, callToAction: e.target.value })}
              placeholder="e.g., Book a 15-min call, Reply with interest, Check out our demo"
            />
          </div>

          <div className="space-y-2">
            <Label>Additional Context (Optional)</Label>
            <Textarea
              value={form.additionalContext}
              onChange={e => setForm({ ...form, additionalContext: e.target.value })}
              placeholder="Any specific angles, case studies, recent news, or things to mention..."
              rows={2}
            />
          </div>

          <Button onClick={handleGenerate} disabled={loading} className="w-full" size="lg">
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Generating 5 Unique Emails...
              </>
            ) : (
              <>
                <Wand2 className="h-4 w-4 mr-2" />
                Generate Emails with AI
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {emails.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">Generated Emails</h3>
            <p className="text-sm text-muted-foreground">
              Click &ldquo;Use This Email&rdquo; to add to your campaign
            </p>
          </div>

          <Tabs value={selectedTab} onValueChange={setSelectedTab}>
            <TabsList className="w-full justify-start overflow-x-auto">
              {emails.map((email, i) => (
                <TabsTrigger key={i} value={String(i)} className="flex items-center gap-2">
                  <span>Version {i + 1}</span>
                  <Badge
                    variant="secondary"
                    className={`${getSpamScoreColor(email.spamScore)} text-white text-xs`}
                  >
                    {email.spamScore}
                  </Badge>
                </TabsTrigger>
              ))}
            </TabsList>

            {emails.map((email, i) => (
              <TabsContent key={i} value={String(i)}>
                <Card>
                  <CardContent className="pt-6 space-y-4">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline">
                          <Sparkles className="h-3 w-3 mr-1" />
                          {email.variationCount.toLocaleString()} unique variations
                        </Badge>
                        <Badge
                          variant="secondary"
                          className={`${getSpamScoreColor(email.spamScore)} text-white`}
                        >
                          Deliverability: {getSpamScoreLabel(email.spamScore)} ({email.spamScore}/100)
                        </Badge>
                      </div>

                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleCopy(email, i)}
                        >
                          {copied === i ? (
                            <Check className="h-4 w-4" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                        </Button>
                        {onSelect && (
                          <Button size="sm" onClick={() => handleUse(email)}>
                            Use This Email
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Subject Line (with Spintax)</Label>
                      <div className="p-3 bg-muted rounded-md font-medium">
                        {email.spintaxSubject}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Email Body (with Spintax)</Label>
                      <div className="p-4 bg-muted rounded-md whitespace-pre-wrap text-sm font-mono leading-relaxed">
                        {email.spintaxBody}
                      </div>
                    </div>

                    {email.tips && email.tips.length > 0 && (
                      <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-950/30 rounded-md border border-amber-200 dark:border-amber-800">
                        <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
                        <div className="text-sm">
                          <p className="font-medium text-amber-800 dark:text-amber-200 mb-1">
                            Improvement Tips
                          </p>
                          <ul className="list-disc list-inside text-amber-700 dark:text-amber-300 space-y-1">
                            {email.tips.map((tip, j) => (
                              <li key={j}>{tip}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            ))}
          </Tabs>
        </div>
      )}
    </div>
  );
}

// Simpler inline version for quick improvements
export function EmailImprover({
  subject,
  body,
  onImproved
}: {
  subject: string;
  body: string;
  onImproved: (subject: string, body: string) => void;
}) {
  const [loading, setLoading] = useState(false);

  const handleImprove = async () => {
    if (!subject || !body) {
      toast.error('Subject and body are required');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/ai/email-writer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'improve',
          subject,
          body
        })
      });

      if (!response.ok) {
        throw new Error('Failed to improve email');
      }

      const data = await response.json();
      onImproved(data.email.spintaxSubject, data.email.spintaxBody);
      toast.success(`Improved! Now has ${data.email.variationCount} variations with ${data.email.spamScore}/100 deliverability score`);

    } catch (error) {
      toast.error('Failed to improve email');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button variant="outline" size="sm" onClick={handleImprove} disabled={loading}>
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <>
          <Wand2 className="h-4 w-4 mr-2" />
          Improve with AI
        </>
      )}
    </Button>
  );
}
