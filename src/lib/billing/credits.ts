// Credit System - Prepaid Credits & Pay-as-you-go

import { createClient } from '@/lib/supabase/server';

export interface Credit {
  id: string;
  workspaceId: string;
  balance: number;
  lifetimePurchased: number;
  lifetimeUsed: number;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreditTransaction {
  id: string;
  workspaceId: string;
  type: 'purchase' | 'usage' | 'refund' | 'adjustment' | 'expiry' | 'bonus';
  amount: number;
  balanceAfter: number;
  description: string;
  referenceType?: string;
  referenceId?: string;
  createdAt: Date;
}

export interface CreditPackage {
  id: string;
  name: string;
  credits: number;
  priceCents: number;
  currency: string;
  bonusCredits: number;
  isActive: boolean;
  stripePriceId?: string;
}

// Default credit packages
export const CREDIT_PACKAGES: Omit<CreditPackage, 'id' | 'stripePriceId'>[] = [
  {
    name: 'Starter Pack',
    credits: 1000,
    priceCents: 999,
    currency: 'usd',
    bonusCredits: 0,
    isActive: true,
  },
  {
    name: 'Growth Pack',
    credits: 5000,
    priceCents: 3999,
    currency: 'usd',
    bonusCredits: 500,
    isActive: true,
  },
  {
    name: 'Business Pack',
    credits: 15000,
    priceCents: 9999,
    currency: 'usd',
    bonusCredits: 2000,
    isActive: true,
  },
  {
    name: 'Enterprise Pack',
    credits: 50000,
    priceCents: 29999,
    currency: 'usd',
    bonusCredits: 10000,
    isActive: true,
  },
];

// Credit cost per action (in credits)
export const CREDIT_COSTS = {
  email_send: 1,
  email_verify: 0.5,
  domain_purchase: 100,
  mailbox_create: 50,
  ai_personalization: 2,
  warmup_email: 0.25,
  bounce_check: 0.1,
};

// Get workspace credit balance
export async function getCreditBalance(
  workspaceId: string
): Promise<Credit | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('credits')
    .select('*')
    .eq('workspace_id', workspaceId)
    .single();

  if (error || !data) return null;

  return {
    id: data.id,
    workspaceId: data.workspace_id,
    balance: data.balance,
    lifetimePurchased: data.lifetime_purchased,
    lifetimeUsed: data.lifetime_used,
    expiresAt: data.expires_at ? new Date(data.expires_at) : undefined,
    createdAt: new Date(data.created_at),
    updatedAt: new Date(data.updated_at),
  };
}

// Initialize credits for new workspace
export async function initializeCredits(
  workspaceId: string,
  initialBalance: number = 0
): Promise<{ success: boolean; creditId?: string; error?: string }> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('credits')
    .insert({
      workspace_id: workspaceId,
      balance: initialBalance,
      lifetime_purchased: initialBalance,
      lifetime_used: 0,
    })
    .select('id')
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  // Record initial transaction if balance > 0
  if (initialBalance > 0) {
    await recordCreditTransaction(workspaceId, {
      type: 'bonus',
      amount: initialBalance,
      description: 'Welcome bonus credits',
    });
  }

  return { success: true, creditId: data.id };
}

// Add credits (purchase or bonus)
export async function addCredits(
  workspaceId: string,
  amount: number,
  options: {
    type: 'purchase' | 'bonus' | 'refund' | 'adjustment';
    description: string;
    referenceType?: string;
    referenceId?: string;
  }
): Promise<{ success: boolean; newBalance?: number; error?: string }> {
  const supabase = await createClient();

  // Get current balance
  const { data: current, error: fetchError } = await supabase
    .from('credits')
    .select('balance, lifetime_purchased')
    .eq('workspace_id', workspaceId)
    .single();

  if (fetchError) {
    // Create credits record if doesn't exist
    if (fetchError.code === 'PGRST116') {
      const init = await initializeCredits(workspaceId, amount);
      if (!init.success) return { success: false, error: init.error };
      return { success: true, newBalance: amount };
    }
    return { success: false, error: fetchError.message };
  }

  const newBalance = current.balance + amount;
  const lifetimePurchased =
    options.type === 'purchase'
      ? current.lifetime_purchased + amount
      : current.lifetime_purchased;

  // Update balance
  const { error: updateError } = await supabase
    .from('credits')
    .update({
      balance: newBalance,
      lifetime_purchased: lifetimePurchased,
      updated_at: new Date().toISOString(),
    })
    .eq('workspace_id', workspaceId);

  if (updateError) {
    return { success: false, error: updateError.message };
  }

  // Record transaction
  await recordCreditTransaction(workspaceId, {
    type: options.type,
    amount: amount,
    balanceAfter: newBalance,
    description: options.description,
    referenceType: options.referenceType,
    referenceId: options.referenceId,
  });

  return { success: true, newBalance };
}

// Consume credits.
// Deliberately not named `useCredits`: this is a server-side function, and a
// `use` prefix makes React's rules-of-hooks lint treat every call site as a
// hook call.
export async function consumeCredits(
  workspaceId: string,
  amount: number,
  options: {
    description: string;
    referenceType?: string;
    referenceId?: string;
  }
): Promise<{ success: boolean; newBalance?: number; error?: string }> {
  const supabase = await createClient();

  // Get current balance
  const { data: current, error: fetchError } = await supabase
    .from('credits')
    .select('balance, lifetime_used')
    .eq('workspace_id', workspaceId)
    .single();

  if (fetchError) {
    return { success: false, error: 'Credit record not found' };
  }

  // Check sufficient balance
  if (current.balance < amount) {
    return { success: false, error: 'Insufficient credits' };
  }

  const newBalance = current.balance - amount;
  const lifetimeUsed = current.lifetime_used + amount;

  // Update balance
  const { error: updateError } = await supabase
    .from('credits')
    .update({
      balance: newBalance,
      lifetime_used: lifetimeUsed,
      updated_at: new Date().toISOString(),
    })
    .eq('workspace_id', workspaceId);

  if (updateError) {
    return { success: false, error: updateError.message };
  }

  // Record transaction
  await recordCreditTransaction(workspaceId, {
    type: 'usage',
    amount: -amount,
    balanceAfter: newBalance,
    description: options.description,
    referenceType: options.referenceType,
    referenceId: options.referenceId,
  });

  return { success: true, newBalance };
}

// Check if workspace has enough credits
export async function hasCredits(
  workspaceId: string,
  requiredAmount: number
): Promise<boolean> {
  const balance = await getCreditBalance(workspaceId);
  return balance !== null && balance.balance >= requiredAmount;
}

// Use credits for specific action
export async function useCreditsForAction(
  workspaceId: string,
  action: keyof typeof CREDIT_COSTS,
  quantity: number = 1,
  referenceId?: string
): Promise<{ success: boolean; creditsUsed?: number; error?: string }> {
  const costPerUnit = CREDIT_COSTS[action];
  const totalCost = costPerUnit * quantity;

  const result = await consumeCredits(workspaceId, totalCost, {
    description: `${action} x ${quantity}`,
    referenceType: action,
    referenceId,
  });

  if (result.success) {
    return { success: true, creditsUsed: totalCost };
  }
  return { success: false, error: result.error };
}

// Record credit transaction
async function recordCreditTransaction(
  workspaceId: string,
  transaction: {
    type: CreditTransaction['type'];
    amount: number;
    balanceAfter?: number;
    description: string;
    referenceType?: string;
    referenceId?: string;
  }
): Promise<void> {
  const supabase = await createClient();

  // Get current balance if not provided
  let balanceAfter = transaction.balanceAfter;
  if (balanceAfter === undefined) {
    const { data } = await supabase
      .from('credits')
      .select('balance')
      .eq('workspace_id', workspaceId)
      .single();
    balanceAfter = data?.balance ?? 0;
  }

  await supabase.from('credit_transactions').insert({
    workspace_id: workspaceId,
    type: transaction.type,
    amount: transaction.amount,
    balance_after: balanceAfter,
    description: transaction.description,
    reference_type: transaction.referenceType,
    reference_id: transaction.referenceId,
  });
}

// Get credit transactions
export async function getCreditTransactions(
  workspaceId: string,
  options: {
    type?: CreditTransaction['type'];
    limit?: number;
    offset?: number;
    startDate?: Date;
    endDate?: Date;
  } = {}
): Promise<{ transactions: CreditTransaction[]; total: number }> {
  const supabase = await createClient();
  const { type, limit = 50, offset = 0, startDate, endDate } = options;

  let query = supabase
    .from('credit_transactions')
    .select('*', { count: 'exact' })
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (type) {
    query = query.eq('type', type);
  }

  if (startDate) {
    query = query.gte('created_at', startDate.toISOString());
  }

  if (endDate) {
    query = query.lte('created_at', endDate.toISOString());
  }

  const { data, count, error } = await query;

  if (error || !data) {
    return { transactions: [], total: 0 };
  }

  return {
    transactions: data.map((t) => ({
      id: t.id,
      workspaceId: t.workspace_id,
      type: t.type,
      amount: t.amount,
      balanceAfter: t.balance_after,
      description: t.description,
      referenceType: t.reference_type,
      referenceId: t.reference_id,
      createdAt: new Date(t.created_at),
    })),
    total: count ?? 0,
  };
}

// Get credit usage summary
export async function getCreditUsageSummary(
  workspaceId: string,
  period: 'day' | 'week' | 'month' = 'month'
): Promise<{
  totalUsed: number;
  totalPurchased: number;
  usageByType: Record<string, number>;
  averageDailyUsage: number;
}> {
  const supabase = await createClient();

  // Calculate start date
  const now = new Date();
  let startDate: Date;
  let days: number;

  switch (period) {
    case 'day':
      startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      days = 1;
      break;
    case 'week':
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      days = 7;
      break;
    case 'month':
    default:
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      days = 30;
      break;
  }

  // Get transactions in period
  const { data: transactions } = await supabase
    .from('credit_transactions')
    .select('*')
    .eq('workspace_id', workspaceId)
    .gte('created_at', startDate.toISOString())
    .lte('created_at', now.toISOString());

  if (!transactions || transactions.length === 0) {
    return {
      totalUsed: 0,
      totalPurchased: 0,
      usageByType: {},
      averageDailyUsage: 0,
    };
  }

  let totalUsed = 0;
  let totalPurchased = 0;
  const usageByType: Record<string, number> = {};

  for (const t of transactions) {
    if (t.type === 'usage') {
      totalUsed += Math.abs(t.amount);
      const refType = t.reference_type || 'other';
      usageByType[refType] = (usageByType[refType] || 0) + Math.abs(t.amount);
    } else if (t.type === 'purchase' || t.type === 'bonus') {
      totalPurchased += t.amount;
    }
  }

  return {
    totalUsed,
    totalPurchased,
    usageByType,
    averageDailyUsage: totalUsed / days,
  };
}

// Purchase credits via Stripe
export async function purchaseCredits(
  workspaceId: string,
  packageId: string,
  stripeSessionId: string
): Promise<{ success: boolean; creditsAdded?: number; error?: string }> {
  const supabase = await createClient();

  // Get package details
  const { data: pkg, error: pkgError } = await supabase
    .from('credit_packages')
    .select('*')
    .eq('id', packageId)
    .eq('is_active', true)
    .single();

  if (pkgError || !pkg) {
    return { success: false, error: 'Package not found' };
  }

  const totalCredits = pkg.credits + pkg.bonus_credits;

  // Add credits
  const result = await addCredits(workspaceId, totalCredits, {
    type: 'purchase',
    description: `Purchased ${pkg.name} (${pkg.credits} + ${pkg.bonus_credits} bonus)`,
    referenceType: 'stripe_session',
    referenceId: stripeSessionId,
  });

  if (result.success) {
    return { success: true, creditsAdded: totalCredits };
  }
  return { success: false, error: result.error };
}

// Expire old credits (for cron job)
export async function expireCredits(): Promise<{
  expiredCount: number;
  totalExpired: number;
}> {
  const supabase = await createClient();
  const now = new Date().toISOString();

  // Find expired credits
  const { data: expired } = await supabase
    .from('credits')
    .select('workspace_id, balance')
    .lt('expires_at', now)
    .gt('balance', 0);

  if (!expired || expired.length === 0) {
    return { expiredCount: 0, totalExpired: 0 };
  }

  let totalExpired = 0;

  // Expire each workspace's credits
  for (const record of expired) {
    totalExpired += record.balance;

    // Record expiry transaction
    await recordCreditTransaction(record.workspace_id, {
      type: 'expiry',
      amount: -record.balance,
      balanceAfter: 0,
      description: 'Credits expired',
    });

    // Zero out balance
    await supabase
      .from('credits')
      .update({
        balance: 0,
        updated_at: now,
      })
      .eq('workspace_id', record.workspace_id);
  }

  return {
    expiredCount: expired.length,
    totalExpired,
  };
}

// Get available credit packages
export async function getCreditPackages(): Promise<CreditPackage[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('credit_packages')
    .select('*')
    .eq('is_active', true)
    .order('credits', { ascending: true });

  if (error || !data) {
    return [];
  }

  return data.map((p) => ({
    id: p.id,
    name: p.name,
    credits: p.credits,
    priceCents: p.price_cents,
    currency: p.currency,
    bonusCredits: p.bonus_credits,
    isActive: p.is_active,
    stripePriceId: p.stripe_price_id,
  }));
}

// Estimate credit cost for operation
export function estimateCreditCost(
  actions: Array<{
    action: keyof typeof CREDIT_COSTS;
    quantity: number;
  }>
): number {
  return actions.reduce((total, { action, quantity }) => {
    return total + CREDIT_COSTS[action] * quantity;
  }, 0);
}
