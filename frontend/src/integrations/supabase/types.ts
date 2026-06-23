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
      alert_rules: {
        Row: {
          application_id: string | null
          channel: string
          condition: string
          config: Json
          created_at: string
          deployment_id: string | null
          enabled: boolean
          id: string
          last_triggered_at: string | null
          name: string
          target: string
          trigger_type: string
          updated_at: string
        }
        Insert: {
          application_id?: string | null
          channel: string
          condition: string
          config?: Json
          created_at?: string
          deployment_id?: string | null
          enabled?: boolean
          id?: string
          last_triggered_at?: string | null
          name: string
          target: string
          trigger_type?: string
          updated_at?: string
        }
        Update: {
          application_id?: string | null
          channel?: string
          condition?: string
          config?: Json
          created_at?: string
          deployment_id?: string | null
          enabled?: boolean
          id?: string
          last_triggered_at?: string | null
          name?: string
          target?: string
          trigger_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "alert_rules_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alert_rules_deployment_id_fkey"
            columns: ["deployment_id"]
            isOneToOne: false
            referencedRelation: "deployments"
            referencedColumns: ["id"]
          },
        ]
      }
      api_tokens: {
        Row: {
          created_at: string
          id: string
          last_used_at: string | null
          name: string
          revoked_at: string | null
          token_hash: string
          token_prefix: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_used_at?: string | null
          name: string
          revoked_at?: string | null
          token_hash: string
          token_prefix: string
        }
        Update: {
          created_at?: string
          id?: string
          last_used_at?: string | null
          name?: string
          revoked_at?: string | null
          token_hash?: string
          token_prefix?: string
        }
        Relationships: []
      }
      applications: {
        Row: {
          created_at: string
          environment: Database["public"]["Enums"]["app_environment"]
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          environment: Database["public"]["Enums"]["app_environment"]
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          environment?: Database["public"]["Enums"]["app_environment"]
          id?: string
          name?: string
        }
        Relationships: []
      }
      deployments: {
        Row: {
          application_id: string
          id: string
          name: string
          started_at: string
        }
        Insert: {
          application_id: string
          id?: string
          name: string
          started_at?: string
        }
        Update: {
          application_id?: string
          id?: string
          name?: string
          started_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deployments_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          application_id: string
          first_seen: string
          hit_count: number
          id: string
          introduced_by_deployment_id: string | null
          last_seen: string
          location: string
          name: string
          severity: Database["public"]["Enums"]["event_severity"]
          status: Database["public"]["Enums"]["event_status"]
          type: Database["public"]["Enums"]["event_type"]
        }
        Insert: {
          application_id: string
          first_seen?: string
          hit_count?: number
          id?: string
          introduced_by_deployment_id?: string | null
          last_seen?: string
          location: string
          name: string
          severity?: Database["public"]["Enums"]["event_severity"]
          status?: Database["public"]["Enums"]["event_status"]
          type: Database["public"]["Enums"]["event_type"]
        }
        Update: {
          application_id?: string
          first_seen?: string
          hit_count?: number
          id?: string
          introduced_by_deployment_id?: string | null
          last_seen?: string
          location?: string
          name?: string
          severity?: Database["public"]["Enums"]["event_severity"]
          status?: Database["public"]["Enums"]["event_status"]
          type?: Database["public"]["Enums"]["event_type"]
        }
        Relationships: [
          {
            foreignKeyName: "events_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_introduced_by_deployment_id_fkey"
            columns: ["introduced_by_deployment_id"]
            isOneToOne: false
            referencedRelation: "deployments"
            referencedColumns: ["id"]
          },
        ]
      }
      integrations: {
        Row: {
          config: Json
          id: string
          status: string
          type: string
        }
        Insert: {
          config?: Json
          id?: string
          status: string
          type: string
        }
        Update: {
          config?: Json
          id?: string
          status?: string
          type?: string
        }
        Relationships: []
      }
      log_lines: {
        Row: {
          id: string
          level: Database["public"]["Enums"]["log_level"]
          message: string
          snapshot_id: string
          timestamp: string
        }
        Insert: {
          id?: string
          level: Database["public"]["Enums"]["log_level"]
          message: string
          snapshot_id: string
          timestamp?: string
        }
        Update: {
          id?: string
          level?: Database["public"]["Enums"]["log_level"]
          message?: string
          snapshot_id?: string
          timestamp?: string
        }
        Relationships: [
          {
            foreignKeyName: "log_lines_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      redaction_rules: {
        Row: {
          created_at: string
          enabled: boolean
          id: string
          kind: string
          name: string
          value: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          id?: string
          kind: string
          name: string
          value: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          id?: string
          kind?: string
          name?: string
          value?: string
        }
        Relationships: []
      }
      servers: {
        Row: {
          agent_version: string
          application_id: string
          hostname: string
          id: string
          last_seen: string
          status: Database["public"]["Enums"]["server_status"]
        }
        Insert: {
          agent_version: string
          application_id: string
          hostname: string
          id?: string
          last_seen?: string
          status?: Database["public"]["Enums"]["server_status"]
        }
        Update: {
          agent_version?: string
          application_id?: string
          hostname?: string
          id?: string
          last_seen?: string
          status?: Database["public"]["Enums"]["server_status"]
        }
        Relationships: [
          {
            foreignKeyName: "servers_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
        ]
      }
      snapshots: {
        Row: {
          deployment_id: string
          event_id: string
          id: string
          message: string
          server_id: string
          thread_name: string
          timestamp: string
        }
        Insert: {
          deployment_id: string
          event_id: string
          id?: string
          message: string
          server_id: string
          thread_name: string
          timestamp?: string
        }
        Update: {
          deployment_id?: string
          event_id?: string
          id?: string
          message?: string
          server_id?: string
          thread_name?: string
          timestamp?: string
        }
        Relationships: [
          {
            foreignKeyName: "snapshots_deployment_id_fkey"
            columns: ["deployment_id"]
            isOneToOne: false
            referencedRelation: "deployments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "snapshots_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "snapshots_server_id_fkey"
            columns: ["server_id"]
            isOneToOne: false
            referencedRelation: "servers"
            referencedColumns: ["id"]
          },
        ]
      }
      stack_frames: {
        Row: {
          class_name: string
          file: string
          frame_index: number
          id: string
          in_user_code: boolean
          line: number
          method: string
          snapshot_id: string
          source_snippet: string | null
        }
        Insert: {
          class_name: string
          file: string
          frame_index: number
          id?: string
          in_user_code?: boolean
          line: number
          method: string
          snapshot_id: string
          source_snippet?: string | null
        }
        Update: {
          class_name?: string
          file?: string
          frame_index?: number
          id?: string
          in_user_code?: boolean
          line?: number
          method?: string
          snapshot_id?: string
          source_snippet?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stack_frames_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      team_members: {
        Row: {
          created_at: string
          email: string
          id: string
          name: string | null
          role: string
          status: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          name?: string | null
          role?: string
          status?: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          name?: string | null
          role?: string
          status?: string
        }
        Relationships: []
      }
      variables: {
        Row: {
          frame_id: string
          id: string
          name: string
          redacted: boolean
          type: string
          value: string | null
        }
        Insert: {
          frame_id: string
          id?: string
          name: string
          redacted?: boolean
          type: string
          value?: string | null
        }
        Update: {
          frame_id?: string
          id?: string
          name?: string
          redacted?: boolean
          type?: string
          value?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "variables_frame_id_fkey"
            columns: ["frame_id"]
            isOneToOne: false
            referencedRelation: "stack_frames"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_settings: {
        Row: {
          created_at: string
          id: string
          install_key: string
        }
        Insert: {
          created_at?: string
          id?: string
          install_key: string
        }
        Update: {
          created_at?: string
          id?: string
          install_key?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      app_environment: "production" | "staging" | "development"
      event_severity: "critical" | "error" | "warning" | "info"
      event_status: "active" | "resolved" | "hidden"
      event_type:
        | "uncaught_exception"
        | "caught_exception"
        | "logged_error"
        | "logged_warning"
        | "http_error"
      log_level: "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR"
      server_status: "active" | "dormant" | "offline"
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_environment: ["production", "staging", "development"],
      event_severity: ["critical", "error", "warning", "info"],
      event_status: ["active", "resolved", "hidden"],
      event_type: [
        "uncaught_exception",
        "caught_exception",
        "logged_error",
        "logged_warning",
        "http_error",
      ],
      log_level: ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"],
      server_status: ["active", "dormant", "offline"],
    },
  },
} as const
