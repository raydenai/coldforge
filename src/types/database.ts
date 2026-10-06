// Generated from verified public schema, 2026-10-05. New integrations use separately tested migration contracts.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      campaign_leads: {
        Row: {
          campaign_id: string | null
          created_at: string | null
          current_step: number | null
          id: string
          last_sent_at: string | null
          lead_id: string | null
          next_send_at: string | null
          status: string | null
        }
        Insert: {
          campaign_id?: string | null
          created_at?: string | null
          current_step?: number | null
          id?: string
          last_sent_at?: string | null
          lead_id?: string | null
          next_send_at?: string | null
          status?: string | null
        }
        Update: {
          campaign_id?: string | null
          created_at?: string | null
          current_step?: number | null
          id?: string
          last_sent_at?: string | null
          lead_id?: string | null
          next_send_at?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "campaign_leads_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_leads_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_sequences: {
        Row: {
          body_html: string
          body_text: string | null
          campaign_id: string | null
          condition_type: string | null
          created_at: string | null
          delay_days: number | null
          delay_hours: number | null
          id: string
          step_number: number
          subject: string
          updated_at: string | null
        }
        Insert: {
          body_html: string
          body_text?: string | null
          campaign_id?: string | null
          condition_type?: string | null
          created_at?: string | null
          delay_days?: number | null
          delay_hours?: number | null
          id?: string
          step_number: number
          subject: string
          updated_at?: string | null
        }
        Update: {
          body_html?: string
          body_text?: string | null
          campaign_id?: string | null
          condition_type?: string | null
          created_at?: string | null
          delay_days?: number | null
          delay_hours?: number | null
          id?: string
          step_number?: number
          subject?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "campaign_sequences_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          created_at: string | null
          id: string
          name: string
          organization_id: string | null
          settings: Json | null
          stats: Json | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          name: string
          organization_id?: string | null
          settings?: Json | null
          stats?: Json | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          name?: string
          organization_id?: string | null
          settings?: Json | null
          stats?: Json | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      domains: {
        Row: {
          auto_purchased: boolean | null
          bimi_configured: boolean | null
          created_at: string | null
          dkim_configured: boolean | null
          dkim_private_key_encrypted: string | null
          dkim_selector: string | null
          dmarc_configured: boolean | null
          dns_provider: string | null
          dns_zone_id: string | null
          domain: string
          expires_at: string | null
          health_status: string | null
          id: string
          last_health_check: string | null
          organization_id: string | null
          purchase_price: number | null
          registrar: string | null
          registrar_domain_id: string | null
          spf_configured: boolean | null
          updated_at: string | null
        }
        Insert: {
          auto_purchased?: boolean | null
          bimi_configured?: boolean | null
          created_at?: string | null
          dkim_configured?: boolean | null
          dkim_private_key_encrypted?: string | null
          dkim_selector?: string | null
          dmarc_configured?: boolean | null
          dns_provider?: string | null
          dns_zone_id?: string | null
          domain: string
          expires_at?: string | null
          health_status?: string | null
          id?: string
          last_health_check?: string | null
          organization_id?: string | null
          purchase_price?: number | null
          registrar?: string | null
          registrar_domain_id?: string | null
          spf_configured?: boolean | null
          updated_at?: string | null
        }
        Update: {
          auto_purchased?: boolean | null
          bimi_configured?: boolean | null
          created_at?: string | null
          dkim_configured?: boolean | null
          dkim_private_key_encrypted?: string | null
          dkim_selector?: string | null
          dmarc_configured?: boolean | null
          dns_provider?: string | null
          dns_zone_id?: string | null
          domain?: string
          expires_at?: string | null
          health_status?: string | null
          id?: string
          last_health_check?: string | null
          organization_id?: string | null
          purchase_price?: number | null
          registrar?: string | null
          registrar_domain_id?: string | null
          spf_configured?: boolean | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "domains_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      email_accounts: {
        Row: {
          created_at: string | null
          daily_limit: number | null
          display_name: string | null
          email: string
          health_score: number | null
          id: string
          imap_host: string | null
          imap_port: number | null
          last_error: string | null
          oauth_tokens_encrypted: Json | null
          organization_id: string | null
          provider: string
          sent_today: number | null
          smtp_host: string | null
          smtp_password_encrypted: string | null
          smtp_port: number | null
          smtp_username: string | null
          status: string | null
          updated_at: string | null
          warmup_enabled: boolean | null
          warmup_progress: number | null
        }
        Insert: {
          created_at?: string | null
          daily_limit?: number | null
          display_name?: string | null
          email: string
          health_score?: number | null
          id?: string
          imap_host?: string | null
          imap_port?: number | null
          last_error?: string | null
          oauth_tokens_encrypted?: Json | null
          organization_id?: string | null
          provider: string
          sent_today?: number | null
          smtp_host?: string | null
          smtp_password_encrypted?: string | null
          smtp_port?: number | null
          smtp_username?: string | null
          status?: string | null
          updated_at?: string | null
          warmup_enabled?: boolean | null
          warmup_progress?: number | null
        }
        Update: {
          created_at?: string | null
          daily_limit?: number | null
          display_name?: string | null
          email?: string
          health_score?: number | null
          id?: string
          imap_host?: string | null
          imap_port?: number | null
          last_error?: string | null
          oauth_tokens_encrypted?: Json | null
          organization_id?: string | null
          provider?: string
          sent_today?: number | null
          smtp_host?: string | null
          smtp_password_encrypted?: string | null
          smtp_port?: number | null
          smtp_username?: string | null
          status?: string | null
          updated_at?: string | null
          warmup_enabled?: boolean | null
          warmup_progress?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "email_accounts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_lists: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          lead_count: number | null
          name: string
          organization_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id?: string
          lead_count?: number | null
          name: string
          organization_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          lead_count?: number | null
          name?: string
          organization_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_lists_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          company: string | null
          created_at: string | null
          custom_fields: Json | null
          email: string
          first_name: string | null
          id: string
          last_name: string | null
          linkedin_url: string | null
          list_id: string | null
          organization_id: string | null
          phone: string | null
          status: string | null
          title: string | null
          updated_at: string | null
          validation_status: string | null
        }
        Insert: {
          company?: string | null
          created_at?: string | null
          custom_fields?: Json | null
          email: string
          first_name?: string | null
          id?: string
          last_name?: string | null
          linkedin_url?: string | null
          list_id?: string | null
          organization_id?: string | null
          phone?: string | null
          status?: string | null
          title?: string | null
          updated_at?: string | null
          validation_status?: string | null
        }
        Update: {
          company?: string | null
          created_at?: string | null
          custom_fields?: Json | null
          email?: string
          first_name?: string | null
          id?: string
          last_name?: string | null
          linkedin_url?: string | null
          list_id?: string | null
          organization_id?: string | null
          phone?: string | null
          status?: string | null
          title?: string | null
          updated_at?: string | null
          validation_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "leads_list_id_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "lead_lists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string | null
          id: string
          name: string
          plan: string | null
          settings: Json | null
          slug: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          name: string
          plan?: string | null
          settings?: Json | null
          slug: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          name?: string
          plan?: string | null
          settings?: Json | null
          slug?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      replies: {
        Row: {
          body_html: string | null
          body_text: string | null
          category: string | null
          confidence: number | null
          created_at: string | null
          email_account_id: string | null
          from_email: string
          from_name: string | null
          id: string
          in_reply_to: string | null
          is_auto_detected: boolean | null
          is_read: boolean | null
          lead_id: string | null
          mailbox_id: string | null
          message_id: string | null
          organization_id: string | null
          received_at: string | null
          sent_email_id: string | null
          sentiment: string | null
          snoozed_until: string | null
          status: string | null
          subject: string | null
          thread_id: string | null
          to_email: string
        }
        Insert: {
          body_html?: string | null
          body_text?: string | null
          category?: string | null
          confidence?: number | null
          created_at?: string | null
          email_account_id?: string | null
          from_email: string
          from_name?: string | null
          id?: string
          in_reply_to?: string | null
          is_auto_detected?: boolean | null
          is_read?: boolean | null
          lead_id?: string | null
          mailbox_id?: string | null
          message_id?: string | null
          organization_id?: string | null
          received_at?: string | null
          sent_email_id?: string | null
          sentiment?: string | null
          snoozed_until?: string | null
          status?: string | null
          subject?: string | null
          thread_id?: string | null
          to_email: string
        }
        Update: {
          body_html?: string | null
          body_text?: string | null
          category?: string | null
          confidence?: number | null
          created_at?: string | null
          email_account_id?: string | null
          from_email?: string
          from_name?: string | null
          id?: string
          in_reply_to?: string | null
          is_auto_detected?: boolean | null
          is_read?: boolean | null
          lead_id?: string | null
          mailbox_id?: string | null
          message_id?: string | null
          organization_id?: string | null
          received_at?: string | null
          sent_email_id?: string | null
          sentiment?: string | null
          snoozed_until?: string | null
          status?: string | null
          subject?: string | null
          thread_id?: string | null
          to_email?: string
        }
        Relationships: [
          {
            foreignKeyName: "replies_email_account_id_fkey"
            columns: ["email_account_id"]
            isOneToOne: false
            referencedRelation: "email_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "replies_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "replies_mailbox_id_fkey"
            columns: ["mailbox_id"]
            isOneToOne: false
            referencedRelation: "email_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "replies_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "replies_sent_email_id_fkey"
            columns: ["sent_email_id"]
            isOneToOne: false
            referencedRelation: "sent_emails"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "replies_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "threads"
            referencedColumns: ["id"]
          },
        ]
      }
      sent_emails: {
        Row: {
          body_html: string | null
          body_text: string | null
          bounce_type: string | null
          bounced_at: string | null
          campaign_id: string | null
          campaign_lead_id: string | null
          clicked_at: string | null
          created_at: string | null
          email_account_id: string | null
          from_email: string
          id: string
          lead_id: string | null
          message_id: string | null
          opened_at: string | null
          organization_id: string | null
          replied_at: string | null
          sent_at: string | null
          status: string | null
          subject: string
          to_email: string
        }
        Insert: {
          body_html?: string | null
          body_text?: string | null
          bounce_type?: string | null
          bounced_at?: string | null
          campaign_id?: string | null
          campaign_lead_id?: string | null
          clicked_at?: string | null
          created_at?: string | null
          email_account_id?: string | null
          from_email: string
          id?: string
          lead_id?: string | null
          message_id?: string | null
          opened_at?: string | null
          organization_id?: string | null
          replied_at?: string | null
          sent_at?: string | null
          status?: string | null
          subject: string
          to_email: string
        }
        Update: {
          body_html?: string | null
          body_text?: string | null
          bounce_type?: string | null
          bounced_at?: string | null
          campaign_id?: string | null
          campaign_lead_id?: string | null
          clicked_at?: string | null
          created_at?: string | null
          email_account_id?: string | null
          from_email?: string
          id?: string
          lead_id?: string | null
          message_id?: string | null
          opened_at?: string | null
          organization_id?: string | null
          replied_at?: string | null
          sent_at?: string | null
          status?: string | null
          subject?: string
          to_email?: string
        }
        Relationships: [
          {
            foreignKeyName: "sent_emails_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sent_emails_campaign_lead_id_fkey"
            columns: ["campaign_lead_id"]
            isOneToOne: false
            referencedRelation: "campaign_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sent_emails_email_account_id_fkey"
            columns: ["email_account_id"]
            isOneToOne: false
            referencedRelation: "email_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sent_emails_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sent_emails_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      thread_messages: {
        Row: {
          body_html: string | null
          body_text: string | null
          created_at: string | null
          direction: string
          from_email: string
          from_name: string | null
          has_attachments: boolean | null
          id: string
          in_reply_to: string | null
          message_id: string | null
          received_at: string | null
          sent_at: string
          snippet: string | null
          subject: string | null
          thread_id: string
          to_email: string
        }
        Insert: {
          body_html?: string | null
          body_text?: string | null
          created_at?: string | null
          direction?: string
          from_email: string
          from_name?: string | null
          has_attachments?: boolean | null
          id?: string
          in_reply_to?: string | null
          message_id?: string | null
          received_at?: string | null
          sent_at?: string
          snippet?: string | null
          subject?: string | null
          thread_id: string
          to_email: string
        }
        Update: {
          body_html?: string | null
          body_text?: string | null
          created_at?: string | null
          direction?: string
          from_email?: string
          from_name?: string | null
          has_attachments?: boolean | null
          id?: string
          in_reply_to?: string | null
          message_id?: string | null
          received_at?: string | null
          sent_at?: string
          snippet?: string | null
          subject?: string | null
          thread_id?: string
          to_email?: string
        }
        Relationships: [
          {
            foreignKeyName: "thread_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "threads"
            referencedColumns: ["id"]
          },
        ]
      }
      threads: {
        Row: {
          assigned_to: string | null
          campaign_id: string | null
          category: string | null
          created_at: string | null
          first_message_at: string | null
          id: string
          is_read: boolean | null
          last_message_at: string | null
          lead_id: string | null
          mailbox_id: string
          message_count: number | null
          organization_id: string
          participant_email: string
          participant_name: string | null
          sentiment: string | null
          status: string | null
          subject: string
          thread_external_id: string | null
          updated_at: string | null
        }
        Insert: {
          assigned_to?: string | null
          campaign_id?: string | null
          category?: string | null
          created_at?: string | null
          first_message_at?: string | null
          id?: string
          is_read?: boolean | null
          last_message_at?: string | null
          lead_id?: string | null
          mailbox_id: string
          message_count?: number | null
          organization_id: string
          participant_email: string
          participant_name?: string | null
          sentiment?: string | null
          status?: string | null
          subject: string
          thread_external_id?: string | null
          updated_at?: string | null
        }
        Update: {
          assigned_to?: string | null
          campaign_id?: string | null
          category?: string | null
          created_at?: string | null
          first_message_at?: string | null
          id?: string
          is_read?: boolean | null
          last_message_at?: string | null
          lead_id?: string | null
          mailbox_id?: string
          message_count?: number | null
          organization_id?: string
          participant_email?: string
          participant_name?: string | null
          sentiment?: string | null
          status?: string | null
          subject?: string
          thread_external_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "threads_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "threads_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "threads_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "threads_mailbox_id_fkey"
            columns: ["mailbox_id"]
            isOneToOne: false
            referencedRelation: "email_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "threads_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          avatar_url: string | null
          created_at: string | null
          email: string
          full_name: string | null
          id: string
          organization_id: string | null
          role: string | null
          settings: Json | null
          updated_at: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string | null
          email: string
          full_name?: string | null
          id: string
          organization_id?: string | null
          role?: string | null
          settings?: Json | null
          updated_at?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string | null
          email?: string
          full_name?: string | null
          id?: string
          organization_id?: string | null
          role?: string | null
          settings?: Json | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "users_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      warmup_emails: {
        Row: {
          from_account_id: string | null
          id: string
          message_id: string | null
          opened_at: string | null
          replied_at: string | null
          sent_at: string | null
          status: string | null
          subject: string | null
          to_account_id: string | null
        }
        Insert: {
          from_account_id?: string | null
          id?: string
          message_id?: string | null
          opened_at?: string | null
          replied_at?: string | null
          sent_at?: string | null
          status?: string | null
          subject?: string | null
          to_account_id?: string | null
        }
        Update: {
          from_account_id?: string | null
          id?: string
          message_id?: string | null
          opened_at?: string | null
          replied_at?: string | null
          sent_at?: string | null
          status?: string | null
          subject?: string | null
          to_account_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "warmup_emails_from_account_id_fkey"
            columns: ["from_account_id"]
            isOneToOne: false
            referencedRelation: "email_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "warmup_emails_to_account_id_fkey"
            columns: ["to_account_id"]
            isOneToOne: false
            referencedRelation: "email_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_user_org_id: { Args: never; Returns: string }
      is_org_admin: { Args: never; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

export type InsertTables<T extends keyof Database["public"]["Tables"]> = TablesInsert<T>
export type UpdateTables<T extends keyof Database["public"]["Tables"]> = TablesUpdate<T>
