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
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      bank_balances: {
        Row: {
          bank_name: string
          created_at: string
          final_amount: number
          id: string
          shift_id: string
        }
        Insert: {
          bank_name: string
          created_at?: string
          final_amount?: number
          id?: string
          shift_id: string
        }
        Update: {
          bank_name?: string
          created_at?: string
          final_amount?: number
          id?: string
          shift_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bank_balances_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
        ]
      }
      ppob_balances: {
        Row: {
          created_at: string
          final_amount: number
          id: string
          provider_name: string
          shift_id: string
        }
        Insert: {
          created_at?: string
          final_amount?: number
          id?: string
          provider_name: string
          shift_id: string
        }
        Update: {
          created_at?: string
          final_amount?: number
          id?: string
          provider_name?: string
          shift_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ppob_balances_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          full_name: string | null
          id: string
          username: string
        }
        Insert: {
          created_at?: string
          full_name?: string | null
          id: string
          username: string
        }
        Update: {
          created_at?: string
          full_name?: string | null
          id?: string
          username?: string
        }
        Relationships: []
      }
      receivables: {
        Row: {
          created_at: string
          customer_name: string
          debt_amount: number
          due_date: string | null
          id: string
          paid_at: string | null
          shift_id: string
          status: Database["public"]["Enums"]["receivable_status"]
          transaction_id: string | null
        }
        Insert: {
          created_at?: string
          customer_name: string
          debt_amount: number
          due_date?: string | null
          id?: string
          paid_at?: string | null
          shift_id: string
          status?: Database["public"]["Enums"]["receivable_status"]
          transaction_id?: string | null
        }
        Update: {
          created_at?: string
          customer_name?: string
          debt_amount?: number
          due_date?: string | null
          id?: string
          paid_at?: string | null
          shift_id?: string
          status?: Database["public"]["Enums"]["receivable_status"]
          transaction_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "receivables_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receivables_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      shifts: {
        Row: {
          created_at: string
          deposit_amount: number
          end_time: string | null
          expense_notes: string | null
          final_physical_balance: number | null
          id: string
          initial_physical_balance: number
          start_time: string
          status: Database["public"]["Enums"]["shift_status"]
          topup_request: number
          total_expenses: number
          user_id: string
        }
        Insert: {
          created_at?: string
          deposit_amount?: number
          end_time?: string | null
          expense_notes?: string | null
          final_physical_balance?: number | null
          id?: string
          initial_physical_balance?: number
          start_time?: string
          status?: Database["public"]["Enums"]["shift_status"]
          topup_request?: number
          total_expenses?: number
          user_id: string
        }
        Update: {
          created_at?: string
          deposit_amount?: number
          end_time?: string | null
          expense_notes?: string | null
          final_physical_balance?: number | null
          id?: string
          initial_physical_balance?: number
          start_time?: string
          status?: Database["public"]["Enums"]["shift_status"]
          topup_request?: number
          total_expenses?: number
          user_id?: string
        }
        Relationships: []
      }
      transactions: {
        Row: {
          client_ref: string | null
          created_at: string
          customer_fee: number
          destination_account: string
          id: string
          note: string | null
          principal_amount: number
          profit_net: number | null
          provider_cost: number
          shift_id: string
          source_account: string
          transaction_type: Database["public"]["Enums"]["txn_type"]
        }
        Insert: {
          client_ref?: string | null
          created_at?: string
          customer_fee?: number
          destination_account: string
          id?: string
          note?: string | null
          principal_amount?: number
          profit_net?: number | null
          provider_cost?: number
          shift_id: string
          source_account: string
          transaction_type: Database["public"]["Enums"]["txn_type"]
        }
        Update: {
          client_ref?: string | null
          created_at?: string
          customer_fee?: number
          destination_account?: string
          id?: string
          note?: string | null
          principal_amount?: number
          profit_net?: number | null
          provider_cost?: number
          shift_id?: string
          source_account?: string
          transaction_type?: Database["public"]["Enums"]["txn_type"]
        }
        Relationships: [
          {
            foreignKeyName: "transactions_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      shift_is_readable: { Args: { _shift_id: string }; Returns: boolean }
      shift_is_writable: { Args: { _shift_id: string }; Returns: boolean }
    }
    Enums: {
      app_role: "owner" | "cashier"
      receivable_status: "pending" | "paid"
      shift_status: "open" | "closed"
      txn_type: "tarik_tunai" | "setor_tunai" | "transfer" | "ppob"
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
      app_role: ["owner", "cashier"],
      receivable_status: ["pending", "paid"],
      shift_status: ["open", "closed"],
      txn_type: ["tarik_tunai", "setor_tunai", "transfer", "ppob"],
    },
  },
} as const
