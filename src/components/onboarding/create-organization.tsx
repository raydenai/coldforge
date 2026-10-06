'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Building2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

interface CreateOrganizationProps {
  onSuccess?: () => void;
}

export function CreateOrganization({ onSuccess }: CreateOrganizationProps) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      toast.error('Please enter an organization name');
      return;
    }

    setLoading(true);

    try {
      const response = await fetch('/api/settings/organization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || 'Failed to create organization');
      }

      toast.success('Organization created successfully!');

      if (onSuccess) {
        onSuccess();
      } else {
        router.push('/dashboard');
        router.refresh();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create organization');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1 text-center">
          <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
            <Building2 className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-2xl font-bold">Create Your Organization</CardTitle>
          <CardDescription>
            Set up your organization to prepare campaigns and connect Winnr
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Organization Name</Label>
              <Input
                id="name"
                type="text"
                placeholder="My Company"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                disabled={loading}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                This is your team or company name. You can change it later.
              </p>
            </div>
          </CardContent>
          <CardFooter>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create Organization'
              )}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
