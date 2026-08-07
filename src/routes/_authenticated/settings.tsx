import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Loader2,
  User,
  Shield,
  Users,
  ArrowLeft,
  Copy,
  Check,
  KeyRound,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, type AppRole } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({
    meta: [
      { title: "Pengaturan — Kasir BRILink" },
      { property: "og:title", content: "Pengaturan — Kasir BRILink" },
    ],
  }),
  component: SettingsPage,
});

type UserProfile = {
  id: string;
  username: string;
  full_name: string | null;
  created_at: string;
  email?: string;
  role?: AppRole;
};

function SettingsPage() {
  const { user, role } = useAuth();
  const isOwner = role === "owner";

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");

  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  // Add cashier dialog
  const [showAddCashier, setShowAddCashier] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [addingCashier, setAddingCashier] = useState(false);

  // Reset password dialog
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [resetUserId, setResetUserId] = useState<string | null>(null);
  const [resetUserName, setResetUserName] = useState("");
  const [newResetPassword, setNewResetPassword] = useState("");
  const [resettingPassword, setResettingPassword] = useState(false);

  const [copied, setCopied] = useState(false);

  const fetchProfile = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();
    if (data) {
      const p: UserProfile = {
        id: data.id,
        username: data.username,
        full_name: data.full_name,
        created_at: data.created_at,
        email: user.email ?? "",
      };
      if (role) p.role = role;
      setProfile(p);
      setFullName(data.full_name ?? "");
      setUsername(data.username);
    }
    setLoading(false);
  }, [user, role]);

  const fetchUsers = useCallback(async () => {
    if (!isOwner) return;
    setLoadingUsers(true);
    const { data: profiles } = await supabase.from("profiles").select("*");
    const { data: roles } = await supabase.from("user_roles").select("user_id, role");
    if (profiles && roles) {
      const roleMap = new Map<string, AppRole>();
      roles.forEach((r) => {
        if (!roleMap.has(r.user_id)) {
          roleMap.set(r.user_id, r.role);
        }
      });
      const merged: UserProfile[] = profiles.map((p) => ({
        ...p,
        role: roleMap.get(p.id) ?? "cashier",
      }));
      setUsers(merged);
    }
    setLoadingUsers(false);
  }, [isOwner]);

  useEffect(() => {
    fetchProfile();
    if (isOwner) fetchUsers();
  }, [fetchProfile, isOwner, fetchUsers]);

  const saveProfile = async () => {
    if (!user) return;
    setSaving(true);
    const { error } = await supabase
      .from("profiles")
      .update({ full_name: fullName || null, username })
      .eq("id", user.id);
    setSaving(false);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Profil tersimpan");
      fetchProfile();
    }
  };

  const addCashier = async () => {
    if (!newEmail || !newPassword || !newUsername) {
      toast.error("Semua field wajib diisi");
      return;
    }
    setAddingCashier(true);

    // We need to use Supabase Admin API to create users.
    // Since we only have anon key, we'll use a workaround:
    // Insert profile + role directly, then prompt owner to create auth user via dashboard.
    // But let's try signUp which works with anon key.
    const { data, error } = await supabase.auth.signUp({
      email: newEmail,
      password: newPassword,
      options: {
        emailRedirectTo: window.location.origin,
        data: { username: newUsername },
      },
    });

    if (error) {
      toast.error(error.message);
      setAddingCashier(false);
      return;
    }

    if (data.user) {
      // Update role to cashier (the trigger sets first user as owner, but we force cashier)
      await supabase.from("user_roles").upsert(
        { user_id: data.user.id, role: "cashier" },
        { onConflict: "user_id,role" },
      );

      toast.success(`Akun kasir ${newEmail} berhasil dibuat`);
      setShowAddCashier(false);
      setNewEmail("");
      setNewPassword("");
      setNewUsername("");
      fetchUsers();
    } else {
      toast.success("Akun dibuat. Menunggu konfirmasi email.");
      setShowAddCashier(false);
      setNewEmail("");
      setNewPassword("");
      setNewUsername("");
    }
    setAddingCashier(false);
  };

  const resetPassword = async () => {
    if (!resetUserId || !newResetPassword) {
      toast.error("Password baru wajib diisi");
      return;
    }
    setResettingPassword(true);

    // With anon key we cannot admin-update passwords.
    // We'll send a password reset email instead.
    // For a real implementation, this needs a Supabase Edge Function with service_role.
    const { error } = await supabase.auth.admin.updateUserById(resetUserId, {
      password: newResetPassword,
    });

    if (error) {
      // Fallback: send reset email
      toast.error("Tidak bisa reset langsung. Mengirim email reset...");
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(
        profile?.email ?? "",
        { redirectTo: window.location.origin },
      );
      if (resetError) {
        toast.error(resetError.message);
      } else {
        toast.success("Email reset password terkirim");
      }
    } else {
      toast.success("Password berhasil direset");
      setShowResetPassword(false);
      setNewResetPassword("");
    }
    setResettingPassword(false);
  };

  const copyEmail = (email: string) => {
    navigator.clipboard.writeText(email);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          to="/dashboard"
          className="inline-flex items-center justify-center rounded-lg border border-border p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <h1 className="font-display text-xl font-bold sm:text-2xl">Pengaturan</h1>
      </div>

      {/* Profile Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="size-5 text-primary" />
            Profil Saya
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="email-display">Email</Label>
              <Input
                id="email-display"
                value={profile?.email ?? ""}
                disabled
                className="h-11 bg-muted"
              />
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <div className="flex h-11 items-center">
                <Badge variant={isOwner ? "default" : "secondary"} className="text-sm">
                  <Shield className="mr-1 size-3" />
                  {isOwner ? "Owner" : "Kasir"}
                </Badge>
              </div>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="username-input">Username</Label>
              <Input
                id="username-input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="username"
                maxLength={40}
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="fullname-input">Nama Lengkap</Label>
              <Input
                id="fullname-input"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Nama lengkap"
                maxLength={100}
                className="h-11"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button onClick={saveProfile} disabled={saving}>
              {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
              Simpan
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* User Management - Owner Only */}
      {isOwner && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Users className="size-5 text-primary" />
              Manajemen Pengguna
            </CardTitle>
            <Button size="sm" onClick={() => setShowAddCashier(true)}>
              + Tambah Kasir
            </Button>
          </CardHeader>
          <CardContent>
            {loadingUsers ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : users.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Belum ada pengguna terdaftar.
              </p>
            ) : (
              <div className="space-y-3">
                {users.map((u) => (
                  <div
                    key={u.id}
                    className="flex flex-col gap-3 rounded-lg border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex size-10 items-center justify-center rounded-full bg-secondary text-sm font-bold">
                        {(u.username ?? "U").charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{u.username}</span>
                          <Badge variant={u.role === "owner" ? "default" : "secondary"}>
                            {u.role === "owner" ? "Owner" : "Kasir"}
                          </Badge>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {u.email ?? u.id.slice(0, 8)}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {u.email && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => copyEmail(u.email!)}
                          title="Salin email"
                        >
                          {copied ? (
                            <Check className="size-4 text-success" />
                          ) : (
                            <Copy className="size-4" />
                          )}
                        </Button>
                      )}
                      {u.role !== "owner" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setResetUserId(u.id);
                            setResetUserName(u.username);
                            setShowResetPassword(true);
                          }}
                        >
                          <KeyRound className="mr-1 size-3" />
                          Reset Password
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Add Cashier Dialog */}
      <Dialog open={showAddCashier} onOpenChange={setShowAddCashier}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Tambah Akun Kasir</DialogTitle>
            <DialogDescription>
              Buat akun baru untuk kasir. Mereka akan otomatis mendapat role Kasir.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="new-username">Username</Label>
              <Input
                id="new-username"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder="kasir_baru"
                maxLength={40}
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-email">Email</Label>
              <Input
                id="new-email"
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="kasir@agen.id"
                maxLength={255}
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">Password</Label>
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Minimal 6 karakter"
                maxLength={72}
                className="h-11"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setShowAddCashier(false)}>
              Batal
            </Button>
            <Button onClick={addCashier} disabled={addingCashier}>
              {addingCashier && <Loader2 className="mr-2 size-4 animate-spin" />}
              Buat Akun
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog open={showResetPassword} onOpenChange={setShowResetPassword}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset Password</DialogTitle>
            <DialogDescription>
              Atur password baru untuk <span className="font-medium">{resetUserName}</span>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="reset-password">Password Baru</Label>
              <Input
                id="reset-password"
                type="password"
                value={newResetPassword}
                onChange={(e) => setNewResetPassword(e.target.value)}
                placeholder="Minimal 6 karakter"
                maxLength={72}
                className="h-11"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setShowResetPassword(false)}>
              Batal
            </Button>
            <Button onClick={resetPassword} disabled={resettingPassword}>
              {resettingPassword && <Loader2 className="mr-2 size-4 animate-spin" />}
              Reset Password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
