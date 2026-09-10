export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15";
  };
  public: {
    Tables: {
      branches: {
        Row: {
          id: string;
          name: string;
          address: string | null;
          is_active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          address?: string | null;
          is_active?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          address?: string | null;
          is_active?: boolean;
          created_at?: string;
        };
        Relationships: [];
      };
      shift_amendments: {
        Row: {
          action: string;
          after_data: Json | null;
          before_data: Json;
          created_at: string;
          id: string;
          shift_id: string;
          user_id: string;
        };
        Insert: {
          action: string;
          after_data?: Json | null;
          before_data: Json;
          created_at?: string;
          id?: string;
          shift_id: string;
          user_id: string;
        };
        Update: {
          action?: string;
          after_data?: Json | null;
          before_data?: Json;
          created_at?: string;
          id?: string;
          shift_id?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      bank_balances: {
        Row: {
          bank_name: string;
          created_at: string;
          final_amount: number;
          id: string;
          initial_amount: number;
          shift_id: string;
        };
        Insert: {
          bank_name: string;
          created_at?: string;
          final_amount?: number;
          id?: string;
          initial_amount?: number;
          shift_id: string;
        };
        Update: {
          bank_name?: string;
          created_at?: string;
          final_amount?: number;
          id?: string;
          initial_amount?: number;
          shift_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "bank_balances_shift_id_fkey";
            columns: ["shift_id"];
            isOneToOne: false;
            referencedRelation: "shifts";
            referencedColumns: ["id"];
          },
        ];
      };
      ppob_balances: {
        Row: {
          created_at: string;
          final_amount: number;
          id: string;
          initial_amount: number;
          provider_name: string;
          shift_id: string;
          topup_amount: number;
        };
        Insert: {
          created_at?: string;
          final_amount?: number;
          id?: string;
          initial_amount?: number;
          provider_name: string;
          shift_id: string;
          topup_amount?: number;
        };
        Update: {
          created_at?: string;
          final_amount?: number;
          id?: string;
          initial_amount?: number;
          provider_name?: string;
          shift_id?: string;
          topup_amount?: number;
        };
        Relationships: [
          {
            foreignKeyName: "ppob_balances_shift_id_fkey";
            columns: ["shift_id"];
            isOneToOne: false;
            referencedRelation: "shifts";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          branch_id: string | null;
          created_at: string;
          full_name: string | null;
          id: string;
          is_active: boolean;
          username: string;
        };
        Insert: {
          branch_id?: string | null;
          created_at?: string;
          full_name?: string | null;
          id: string;
          is_active?: boolean;
          username: string;
        };
        Update: {
          branch_id?: string | null;
          created_at?: string;
          full_name?: string | null;
          id?: string;
          is_active?: boolean;
          username?: string;
        };
        Relationships: [
          {
            foreignKeyName: "profiles_branch_id_fkey";
            columns: ["branch_id"];
            isOneToOne: false;
            referencedRelation: "branches";
            referencedColumns: ["id"];
          },
        ];
      };
      receivables: {
        Row: {
          created_at: string;
          customer_name: string;
          debt_amount: number;
          due_date: string | null;
          id: string;
          paid_at: string | null;
          shift_id: string;
          status: Database["public"]["Enums"]["receivable_status"];
          transaction_id: string | null;
        };
        Insert: {
          created_at?: string;
          customer_name: string;
          debt_amount: number;
          due_date?: string | null;
          id?: string;
          paid_at?: string | null;
          shift_id: string;
          status?: Database["public"]["Enums"]["receivable_status"];
          transaction_id?: string | null;
        };
        Update: {
          created_at?: string;
          customer_name?: string;
          debt_amount?: number;
          due_date?: string | null;
          id?: string;
          paid_at?: string | null;
          shift_id?: string;
          status?: Database["public"]["Enums"]["receivable_status"];
          transaction_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "receivables_shift_id_fkey";
            columns: ["shift_id"];
            isOneToOne: false;
            referencedRelation: "shifts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "receivables_transaction_id_fkey";
            columns: ["transaction_id"];
            isOneToOne: false;
            referencedRelation: "transactions";
            referencedColumns: ["id"];
          },
        ];
      };
      shifts: {
        Row: {
          additional_capital: number;
          branch_id: string | null;
          created_at: string;
          deposit_amount: number;
          deposit_confirmed: boolean;
          end_time: string | null;
          expense_notes: string | null;
          final_physical_balance: number | null;
          id: string;
          initial_physical_balance: number;
          modal_akhir: number | null;
          modal_awal: number | null;
          owner_withdrawal: number;
          rejected_at: string | null;
          rejected_snapshot: Json | null;
          rejection_reason: string | null;
          settlement_amount: number;
          start_time: string;
          status: Database["public"]["Enums"]["shift_status"];
          topup_request: number;
          total_expenses: number;
          user_id: string;
        };
        Insert: {
          additional_capital?: number;
          branch_id?: string | null;
          created_at?: string;
          deposit_amount?: number;
          deposit_confirmed?: boolean;
          end_time?: string | null;
          expense_notes?: string | null;
          final_physical_balance?: number | null;
          id?: string;
          initial_physical_balance?: number;
          modal_akhir?: number | null;
          modal_awal?: number | null;
          owner_withdrawal?: number;
          rejected_at?: string | null;
          rejected_snapshot?: Json | null;
          rejection_reason?: string | null;
          settlement_amount?: number;
          start_time?: string;
          status?: Database["public"]["Enums"]["shift_status"];
          topup_request?: number;
          total_expenses?: number;
          user_id: string;
        };
        Update: {
          additional_capital?: number;
          branch_id?: string | null;
          created_at?: string;
          deposit_amount?: number;
          deposit_confirmed?: boolean;
          end_time?: string | null;
          expense_notes?: string | null;
          final_physical_balance?: number | null;
          id?: string;
          initial_physical_balance?: number;
          modal_akhir?: number | null;
          modal_awal?: number | null;
          owner_withdrawal?: number;
          rejected_at?: string | null;
          rejected_snapshot?: Json | null;
          rejection_reason?: string | null;
          settlement_amount?: number;
          start_time?: string;
          status?: Database["public"]["Enums"]["shift_status"];
          topup_request?: number;
          total_expenses?: number;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "shifts_branch_id_fkey";
            columns: ["branch_id"];
            isOneToOne: false;
            referencedRelation: "branches";
            referencedColumns: ["id"];
          },
        ];
      };
      transactions: {
        Row: {
          client_ref: string | null;
          created_at: string;
          customer_fee: number;
          destination_account: string;
          id: string;
          note: string | null;
          principal_amount: number;
          profit_net: number | null;
          provider_cost: number;
          shift_id: string;
          source_account: string;
          transaction_type: Database["public"]["Enums"]["txn_type"];
        };
        Insert: {
          client_ref?: string | null;
          created_at?: string;
          customer_fee?: number;
          destination_account: string;
          id?: string;
          note?: string | null;
          principal_amount?: number;
          profit_net?: number | null;
          provider_cost?: number;
          shift_id: string;
          source_account: string;
          transaction_type: Database["public"]["Enums"]["txn_type"];
        };
        Update: {
          client_ref?: string | null;
          created_at?: string;
          customer_fee?: number;
          destination_account?: string;
          id?: string;
          note?: string | null;
          principal_amount?: number;
          profit_net?: number | null;
          provider_cost?: number;
          shift_id?: string;
          source_account?: string;
          transaction_type?: Database["public"]["Enums"]["txn_type"];
        };
        Relationships: [
          {
            foreignKeyName: "transactions_shift_id_fkey";
            columns: ["shift_id"];
            isOneToOne: false;
            referencedRelation: "shifts";
            referencedColumns: ["id"];
          },
        ];
      };
      user_roles: {
        Row: {
          created_at: string;
          id: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          user_id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      resolve_login_email: {
        Args: {
          identifier: string;
        };
        Returns: string | null;
      };
      /** @deprecated Retired — raises an exception. Use admin_set_user_active. */
      admin_delete_user: {
        Args: {
          target_user_id: string;
        };
        Returns: void;
      };
      admin_set_user_active: {
        Args: {
          target_user_id: string;
          active: boolean;
        };
        Returns: void;
      };
      admin_list_users: {
        Args: Record<string, never>;
        Returns: {
          id: string;
          email: string;
          username: string;
          full_name: string | null;
          created_at: string;
          branch_id: string | null;
          is_active: boolean;
        }[];
      };
      admin_create_user: {
        Args: {
          target_email: string;
          target_password: string;
          target_username?: string;
          target_full_name?: string;
        };
        Returns: string;
      };
      admin_update_user_email: {
        Args: {
          target_user_id: string;
          new_email: string;
        };
        Returns: void;
      };
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
      };
      close_shift_atomic: {
        Args: {
          _shift_id: string;
          _final_cash: number;
          _additional_capital: number;
          _expenses: number;
          _expense_notes?: string | null;
          _topup: number;
          _deposit: number;
          _settlement: number;
          _bank_snapshots: Json;
          _ppob_snapshots: Json;
        };
        Returns: void;
      };
      shift_is_readable: { Args: { _shift_id: string }; Returns: boolean };
      shift_is_writable: { Args: { _shift_id: string }; Returns: boolean };
      owner_adjust_balance: {
        Args: {
          _shift_id: string;
          _kind: string;
          _name: string;
          _field: string;
          _new_value: number;
          _reason: string;
        };
        Returns: undefined;
      };
      owner_adjust_shift_field: {
        Args: {
          _shift_id: string;
          _field: string;
          _new_value: number;
          _reason: string;
        };
        Returns: undefined;
      };
      owner_reject_shift_report: {
        Args: {
          _shift_id: string;
          _reason: string;
        };
        Returns: undefined;
      };
      amend_open_shift: {
        Args: {
          _shift_id: string;
          _initial_cash: number;
          _bank_snapshots: Json;
          _ppob_snapshots: Json;
        };
        Returns: undefined;
      };
      cancel_open_shift: {
        Args: {
          _shift_id: string;
        };
        Returns: undefined;
      };
      last_closed_shift_balances: {
        Args: Record<string, never>;
        Returns: {
          shift: {
            id: string;
            end_time: string | null;
            final_physical_balance: number | null;
            closed_by: string | null;
            is_own: boolean;
          };
          banks: { bank_name: string; final_amount: number }[];
          ppob: { provider_name: string; final_amount: number }[];
        } | null;
      };
      open_shift_atomic: {
        Args: {
          _user_id: string;
          _branch_id: string | null;
          _initial_cash: number;
          _bank_snapshots: Json;
          _ppob_snapshots: Json;
        };
        Returns: string;
      };
    };
    Enums: {
      app_role: "owner" | "cashier";
      receivable_status: "pending" | "paid";
      shift_status: "open" | "closed";
      txn_type: "tarik_tunai" | "setor_tunai" | "transfer" | "ppob";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      app_role: ["owner", "cashier"],
      receivable_status: ["pending", "paid"],
      shift_status: ["open", "closed"],
      txn_type: ["tarik_tunai", "setor_tunai", "transfer", "ppob"],
    },
  },
} as const;
