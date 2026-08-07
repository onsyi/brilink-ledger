import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, User, Shield, Users, ArrowLeft, Copy, Check, KeyRound } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, type AppRole } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BranchManagement } from "@/components/BranchManagement";

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
  branch_id?: string | null;
  branch_name?: string | null;
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

  const [showAddCashier, setShowAddCashier] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newBranchId, setNewBranchId] = useState<string>("");
  const [addingCashier, setAddingCashier] = useState(false);

  const [showResetPassword, setShowResetPassword] = useState(false);
  const [resetUserId, setResetUserId] = useState<string | null>(null);
  const [resetUserEmail, setResetUserEmail] = useState("");
  const [resetUserName, setResetUserName] = useState("");
  const [resettingPassword, setResettingPassword] = useState(false);

  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [editBranchUser, setEditBranchUser] = useState<UserProfile | null>(null);
  const [editBranchId, setEditBranchId] = useState<string>("");
  const [savingBranch, setSavingBranch] = useState(false);

  const branches = useQuery({
    queryKey: ["branches"],
    enabled: isOwner,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("branches")
        .select("id, name")
        .eq("is_active", true)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const fetchProfile = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase.from("profiles").select("*").eq("id", user.id).single();
    if (error) {
      toast.error("Gagal memuat profil");
      setLoading(false);
      return;
    }
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
    const { data: profiles, error: profilesErr } = await supabase.from("profiles").select("*");
    const { data: roles } = await supabase.from("user_roles").select("user_id, role");
    const { data: branchRows } = await supabase.from("branches").select("id, name");
    if (profilesErr) {
      toast.error("Gagal memuat daftar pengguna");
      setLoadingUsers(false);
      return;
    }
    if (profiles && roles) {
      const roleMap = new Map<string, AppRole>();
      roles.forEach((r) => {
        if (!roleMap.has(r.user_id)) {
          roleMap.set(r.user_id, r.role);
        }
      });
      const branchMap = new Map<string, string>();
      (branchRows ?? []).forEach((b) => branchMap.set(b.id, b.name));
      const merged: UserProfile[] = profiles.map((p) => ({
        ...p,
        role: roleMap.get(p.id) ?? "cashier",
        branch_name: p.branch_id ? (branchMap.get(p.branch_id) ?? null) : null,
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
    if (!username.trim()) {
      toast.error("Username tidak boleh kosong");
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("profiles")
      .update({ full_name: fullName.trim() || null, username: username.trim() })
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
    if (!newEmail.trim() || !newPassword || !newUsername.trim()) {
      toast.error("Semua field wajib diisi");
      return;
    }
    if (newPassword.length < 6) {
      toast.error("Password minimal 6 karakter");
      return;
    }
    // Simple email format check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail.trim())) {
      toast.error("Format email tidak valid");
      return;
    }
    setAddingCashier(true);

    const { data, error } = await supabase.auth.signUp({
      email: newEmail.trim(),
      password: newPassword,
      options: {
        emailRedirectTo: window.location.origin,
        data: { username: newUsername.trim() },
      },
    });

    if (error) {
      toast.error(error.message);
      setAddingCashier(false);
      return;
    }

    if (data.user) {
      // Set branch_id on the profile if selected
      if (newBranchId) {
        const { error: branchErr } = await supabase
          .from("profiles")
          .update({ branch_id: newBranchId })
          .eq("id", data.user.id);
        if (branchErr) {
          toast.warning("Akun dibuat, tapi gagal menetapkan cabang. Bisa diatur manual nanti.");
        }
      }
      toast.success(`Akun kasir ${newEmail.trim()} berhasil dibuat`);
      setShowAddCashier(false);
      setNewEmail("");
      setNewPassword("");
      setNewUsername("");
      setNewBranchId("");
      fetchUsers();
    } else {
      toast.success("Akun dibuat. Kasir perlu konfirmasi email untuk bisa masuk.");
      setShowAddCashier(false);
      setNewEmail("");
      setNewPassword("");
      setNewUsername("");
      setNewBranchId("");
    }
    setAddingCashier(false);
  };

  const resetPassword = async () => {
    if (!resetUserId || !resetUserEmail) {
      toast.error("Data pengguna tidak lengkap");
      return;
    }
    setResettingPassword(true);

    const { error } = await supabase.auth.resetPasswordForEmail(resetUserEmail, {
      redirectTo: window.location.origin,
    });

    if (error) {
      toast.error("Gagal mengirim email reset. Hubungi admin.");
    } else {
      toast.success(`Email reset password terkirim ke ${resetUserEmail}`);
      setShowResetPassword(false);
    }
    setResettingPassword(false);
  };

  const copyEmail = async (userId: string, email: string) => {
    try {
      await navigator.clipboard.writeText(email);
      setCopiedId(userId);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast.error("Gagal menyalin email");
    }
  };

  const saveBranchAssignment = async () => {
    if (!editBranchUser) return;
    setSavingBranch(true);
    const { error } = await supabase
      .from("profiles")
      .update({ branch_id: editBranchId || null })
      .eq("id", editBranchUser.id);
    setSavingBranch(false);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success(`Cabang ${editBranchUser.username} berhasil diubah`);
      setEditBranchUser(null);
      fetchUsers();
    }
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
                          {u.branch_name && (
                            <Badge variant="outline" className="text-xs">
                              {u.branch_name}
                            </Badge>
                          )}
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
                          onClick={() => copyEmail(u.id, u.email!)}
                          title="Salin email"
                        >
                          {copiedId === u.id ? (
                            <Check className="size-4 text-success" />
                          ) : (
                            <Copy className="size-4" />
                          )}
                        </Button>
                      )}
                      {u.role !== "owner" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditBranchUser(u);
                            setEditBranchId(u.branch_id ?? "");
                          }}
                          title="Ubah cabang"
                        >
                          {u.branch_name ? u.branch_name : "Atur Cabang"}
                        </Button>
                      )}
                      {u.role !== "owner" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setResetUserId(u.id);
                            setResetUserName(u.username);
                            setResetUserEmail(u.email ?? "");
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

      {/* Branch Management - Owner Only */}
      {isOwner && (
        <Card>
          <CardContent className="pt-6">
            <BranchManagement />
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
            {branches.data && branches.data.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="new-branch">Cabang (opsional)</Label>
                <select
                  id="new-branch"
                  value={newBranchId}
                  onChange={(e) => setNewBranchId(e.target.value)}
                  className="flex h-11 w-full rounded-lg border border-border bg-background px-3 text-sm"
                >
                  <option value="">Tidak ada cabang</option>
                  {branches.data.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
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
            <DialogTitle>Kirim Email Reset Password</DialogTitle>
            <DialogDescription>
              Email reset password akan dikirim ke{" "}
              <span className="font-medium">{resetUserEmail}</span>. Kasir akan diarahkan ke halaman
              login untuk mengatur password baru.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setShowResetPassword(false)}>
              Batal
            </Button>
            <Button onClick={resetPassword} disabled={resettingPassword}>
              {resettingPassword && <Loader2 className="mr-2 size-4 animate-spin" />}
              Kirim Email
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Branch Dialog */}
      <Dialog open={!!editBranchUser} onOpenChange={() => setEditBranchUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ubah Cabang</DialogTitle>
            <DialogDescription>
              Tetapkan cabang untuk <span className="font-medium">{editBranchUser?.username}</span>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="edit-branch">Cabang</Label>
              <select
                id="edit-branch"
                value={editBranchId}
                onChange={(e) => setEditBranchId(e.target.value)}
                className="flex h-11 w-full rounded-lg border border-border bg-background px-3 text-sm"
              >
                <option value="">Tidak ada cabang</option>
                {branches.data?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setEditBranchUser(null)}>
              Batal
            </Button>
            <Button onClick={saveBranchAssignment} disabled={savingBranch}>
              {savingBranch && <Loader2 className="mr-2 size-4 animate-spin" />}
              Simpan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
