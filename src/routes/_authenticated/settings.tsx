import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
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
  Eye,
  EyeOff,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, type AppRole } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BranchManagement } from "@/components/BranchManagement";
import { QueryError } from "@/components/QueryError";

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
  is_active?: boolean;
};

/**
 * Sejak profiles punya unique index pada lower(username), nama yang bentrok
 * kembali sebagai 23505 dengan pesan mentah yang menyebut nama constraint.
 * Yang perlu diketahui pengguna cuma satu: nama itu sudah dipakai.
 */
/**
 * Sama persis dengan yang ditegakkan dua lapis di bawah: setelan kekuatan
 * password project (untuk reset & ganti password sendiri) dan pemeriksaan di
 * admin_create_user (untuk akun yang dibuat owner, yang melewati GoTrue).
 * Di sini hanya supaya kesalahan ketahuan sebelum permintaan dikirim.
 */
const PASSWORD_RULE = "Password minimal 10 karakter dan harus memuat huruf serta angka";
const isStrongPassword = (v: string) => v.length >= 10 && /[a-zA-Z]/.test(v) && /[0-9]/.test(v);

function usernameError(error: { code?: string; message: string }, name: string) {
  return error.code === "23505" || error.message.includes("profiles_username_lower_key")
    ? `Username "${name}" sudah dipakai. Pilih nama lain.`
    : error.message;
}

function SettingsPage() {
  const { user, role, loading: authLoading } = useAuth();
  const isOwner = role === "owner";

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");

  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);

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

  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newOwnPassword, setNewOwnPassword] = useState("");
  const [confirmOwnPassword, setConfirmOwnPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  const [editBranchUser, setEditBranchUser] = useState<UserProfile | null>(null);
  const [editBranchId, setEditBranchId] = useState<string>("");
  const [savingBranch, setSavingBranch] = useState(false);

  const [editCashier, setEditCashier] = useState<UserProfile | null>(null);
  const [editUsername, setEditUsername] = useState("");
  const [editFullName, setEditFullName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [savingCashier, setSavingCashier] = useState(false);

  const [toggleUser, setToggleUser] = useState<UserProfile | null>(null);
  const [togglingUser, setTogglingUser] = useState(false);

  const branches = useQuery({
    queryKey: ["branches"],
    enabled: isOwner,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("branches")
        .select("id, name, is_active")
        .order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string; is_active: boolean }[];
    },
  });

  const fetchProfile = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from("profiles")
      .select("id, username, full_name, created_at")
      .eq("id", user.id)
      .single();
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
    setUsersError(null);
    const [
      { data: userList, error: usersErr },
      { data: roles },
      { data: branchRows, error: branchErr },
    ] = await Promise.all([
      supabase.rpc("admin_list_users"),
      supabase.from("user_roles").select("user_id, role"),
      supabase.from("branches").select("id, name"),
    ]);
    if (usersErr) {
      setUsersError(usersErr.message);
      setLoadingUsers(false);
      return;
    }
    if (branchErr) {
      console.warn("[Settings] Failed to load branches:", branchErr.message);
    }
    if (userList && roles) {
      const roleMap = new Map<string, AppRole>();
      roles.forEach((r) => {
        if (!roleMap.has(r.user_id)) {
          roleMap.set(r.user_id, r.role);
        }
      });
      const branchMap = new Map<string, string>();
      (branchRows ?? []).forEach((b) => branchMap.set(b.id, b.name));
      const merged: UserProfile[] = userList.map((u) => ({
        id: u.id,
        username: u.username,
        full_name: u.full_name,
        created_at: u.created_at,
        email: u.email ?? "",
        branch_id: u.branch_id,
        branch_name: u.branch_id ? (branchMap.get(u.branch_id) ?? null) : null,
        role: roleMap.get(u.id) ?? "cashier",
        is_active: u.is_active,
      }));
      setUsers(merged);
    }
    setLoadingUsers(false);
  }, [isOwner]);

  useEffect(() => {
    // fetchProfile() bails out when `user` is still null, so without this the
    // initial loading flag was never cleared and the page spun forever.
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    fetchProfile();
    if (isOwner) fetchUsers();
  }, [authLoading, user, fetchProfile, isOwner, fetchUsers]);

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
      toast.error(usernameError(error, username.trim()));
    } else {
      toast.success("Profil tersimpan");
      fetchProfile();
    }
  };

  const closePasswordDialog = () => {
    setShowChangePassword(false);
    setCurrentPassword("");
    setNewOwnPassword("");
    setConfirmOwnPassword("");
    setShowPasswords(false);
  };

  const changeOwnPassword = async () => {
    const email = profile?.email ?? user?.email ?? "";
    if (!email) {
      toast.error("Email akun tidak diketahui");
      return;
    }
    if (!currentPassword) {
      toast.error("Password saat ini wajib diisi");
      return;
    }
    if (!isStrongPassword(newOwnPassword)) {
      toast.error(PASSWORD_RULE);
      return;
    }
    if (newOwnPassword !== confirmOwnPassword) {
      toast.error("Konfirmasi password tidak cocok");
      return;
    }
    if (newOwnPassword === currentPassword) {
      toast.error("Password baru harus berbeda dari password lama");
      return;
    }

    setChangingPassword(true);
    // Supabase lets any live session set a new password without proving the old
    // one, so an unattended terminal would be enough to take over the account.
    // Re-authenticating first makes the current password a real requirement.
    const { error: verifyError } = await supabase.auth.signInWithPassword({
      email,
      password: currentPassword,
    });
    if (verifyError) {
      setChangingPassword(false);
      toast.error("Password saat ini salah");
      return;
    }

    const { error } = await supabase.auth.updateUser({ password: newOwnPassword });
    setChangingPassword(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Password berhasil diubah");
    closePasswordDialog();
  };

  const addCashier = async () => {
    if (!newEmail.trim() || !newPassword || !newUsername.trim()) {
      toast.error("Semua field wajib diisi");
      return;
    }
    if (!isStrongPassword(newPassword)) {
      toast.error(PASSWORD_RULE);
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail.trim())) {
      toast.error("Format email tidak valid");
      return;
    }
    setAddingCashier(true);

    const { data: newUserId, error } = await supabase.rpc("admin_create_user", {
      target_email: newEmail.trim(),
      target_password: newPassword,
      target_username: newUsername.trim(),
      target_full_name: newUsername.trim(),
    });

    if (error) {
      toast.error(error.message);
      setAddingCashier(false);
      return;
    }

    if (newUserId && newBranchId) {
      const { error: branchErr } = await supabase
        .from("profiles")
        .update({ branch_id: newBranchId })
        .eq("id", newUserId);
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
    setAddingCashier(false);
  };

  const resetPassword = async () => {
    if (!resetUserId || !resetUserEmail) {
      toast.error("Data pengguna tidak lengkap");
      return;
    }
    setResettingPassword(true);

    // Must land on the page that can actually set a password; the site root
    // just redirects to /dashboard and swallows the recovery token.
    const { error } = await supabase.auth.resetPasswordForEmail(resetUserEmail, {
      redirectTo: `${window.location.origin}/reset-password`,
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

  const saveCashierProfile = async () => {
    if (!editCashier) return;
    if (!editUsername.trim()) {
      toast.error("Username tidak boleh kosong");
      return;
    }
    if (!editEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(editEmail.trim())) {
      toast.error("Format email tidak valid");
      return;
    }
    setSavingCashier(true);

    const emailChanged = editEmail.trim() !== editCashier.email;
    const usernameChanged = editUsername.trim() !== editCashier.username;
    const fullNameChanged = (editFullName.trim() || null) !== (editCashier.full_name ?? null);

    if (emailChanged) {
      const { error: rpcErr } = await supabase.rpc("admin_update_user_email", {
        target_user_id: editCashier.id,
        new_email: editEmail.trim(),
      });
      if (rpcErr) {
        toast.error("Gagal update email: " + rpcErr.message);
        setSavingCashier(false);
        return;
      }
    }

    if (usernameChanged || fullNameChanged) {
      const { error } = await supabase
        .from("profiles")
        .update({
          username: editUsername.trim(),
          full_name: editFullName.trim() || null,
        })
        .eq("id", editCashier.id);
      if (error) {
        toast.error(usernameError(error, editUsername.trim()));
        setSavingCashier(false);
        return;
      }
    }

    setSavingCashier(false);
    toast.success(`Profil ${editCashier.username} berhasil diubah`);
    setEditCashier(null);
    fetchUsers();
  };

  const setUserActive = async () => {
    if (!toggleUser) return;
    const nextActive = toggleUser.is_active === false;
    setTogglingUser(true);
    const { error } = await supabase.rpc("admin_set_user_active", {
      target_user_id: toggleUser.id,
      active: nextActive,
    });
    setTogglingUser(false);
    if (error) {
      toast.error("Gagal mengubah status akun: " + error.message);
    } else {
      toast.success(
        nextActive
          ? `Akun ${toggleUser.username} diaktifkan kembali`
          : `Akun ${toggleUser.username} dinonaktifkan`,
      );
      setToggleUser(null);
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
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => setShowChangePassword(true)}>
              <KeyRound className="mr-1.5 size-4" />
              Ubah Password
            </Button>
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
            ) : usersError ? (
              <QueryError message="Gagal memuat daftar pengguna." onRetry={() => fetchUsers()} />
            ) : users.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Belum ada pengguna terdaftar.
              </p>
            ) : (
              <div className="space-y-3">
                {users.map((u) => (
                  <div
                    key={u.id}
                    className={`flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between ${
                      u.is_active === false
                        ? "border-destructive/25 bg-destructive/5 opacity-75"
                        : "border-border"
                    }`}
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
                          {u.is_active === false && (
                            <Badge variant="destructive" className="text-xs">
                              Nonaktif
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
                            setEditCashier(u);
                            setEditUsername(u.username);
                            setEditFullName(u.full_name ?? "");
                            setEditEmail(u.email ?? "");
                          }}
                          title="Edit profil"
                        >
                          Edit
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
                      {u.role !== "owner" && (
                        <Button
                          size="sm"
                          variant={u.is_active === false ? "default" : "destructive"}
                          onClick={() => setToggleUser(u)}
                        >
                          {u.is_active === false ? "Aktifkan" : "Nonaktifkan"}
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

      {/* Change Own Password Dialog */}
      <Dialog
        open={showChangePassword}
        onOpenChange={(open) => {
          if (!open) closePasswordDialog();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-5 text-primary" />
              Ubah Password
            </DialogTitle>
            <DialogDescription>
              Password akun <span className="font-medium">{profile?.email}</span>. Masukkan password
              saat ini untuk memastikan bukan orang lain yang mengubahnya.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="current-password">Password saat ini</Label>
              <div className="relative">
                <Input
                  id="current-password"
                  type={showPasswords ? "text" : "password"}
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  maxLength={72}
                  autoComplete="current-password"
                  className="h-11 pr-11"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPasswords((v) => !v)}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
                >
                  {showPasswords ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-own-password">Password baru</Label>
              <Input
                id="new-own-password"
                type={showPasswords ? "text" : "password"}
                value={newOwnPassword}
                onChange={(e) => setNewOwnPassword(e.target.value)}
                placeholder="Password minimal 10 karakter, memuat huruf dan angka"
                maxLength={72}
                autoComplete="new-password"
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-own-password">Ulangi password baru</Label>
              <Input
                id="confirm-own-password"
                type={showPasswords ? "text" : "password"}
                value={confirmOwnPassword}
                onChange={(e) => setConfirmOwnPassword(e.target.value)}
                placeholder="Ulangi password baru"
                maxLength={72}
                autoComplete="new-password"
                className="h-11"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={closePasswordDialog}>
              Batal
            </Button>
            <Button onClick={changeOwnPassword} disabled={changingPassword}>
              {changingPassword && <Loader2 className="mr-2 size-4 animate-spin" />}
              Simpan Password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
                placeholder="Password minimal 10 karakter, memuat huruf dan angka"
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
              <span className="font-medium">{resetUserName}</span> (
              <span className="font-medium">{resetUserEmail}</span>). Tautan di email membuka
              halaman untuk mengatur password baru.
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

      {/* Edit Cashier Dialog */}
      <Dialog open={!!editCashier} onOpenChange={() => setEditCashier(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Kasir</DialogTitle>
            <DialogDescription>
              Ubah informasi akun kasir: email, username, dan nama lengkap.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="edit-cashier-email">Email</Label>
              <Input
                id="edit-cashier-email"
                type="email"
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
                placeholder="kasir@agen.id"
                maxLength={255}
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-cashier-username">Username</Label>
              <Input
                id="edit-cashier-username"
                value={editUsername}
                onChange={(e) => setEditUsername(e.target.value)}
                placeholder="username"
                maxLength={40}
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-cashier-fullname">Nama Lengkap</Label>
              <Input
                id="edit-cashier-fullname"
                value={editFullName}
                onChange={(e) => setEditFullName(e.target.value)}
                placeholder="Nama lengkap (opsional)"
                maxLength={100}
                className="h-11"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setEditCashier(null)}>
              Batal
            </Button>
            <Button onClick={saveCashierProfile} disabled={savingCashier}>
              {savingCashier && <Loader2 className="mr-2 size-4 animate-spin" />}
              Simpan
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

      {/* Activate / Deactivate User Dialog */}
      <Dialog open={!!toggleUser} onOpenChange={() => setToggleUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {toggleUser?.is_active === false ? "Aktifkan Akun" : "Nonaktifkan Akun"}
            </DialogTitle>
            <DialogDescription>
              {toggleUser?.is_active === false ? (
                <>
                  Aktifkan kembali akun <span className="font-medium">{toggleUser?.username}</span>?
                  Kasir akan dapat masuk dan membuka shift seperti biasa.
                </>
              ) : (
                <>
                  Nonaktifkan akun <span className="font-medium">{toggleUser?.username}</span>?
                  Kasir tidak akan bisa masuk atau membuka shift baru, tetapi seluruh riwayat shift
                  dan transaksinya tetap tersimpan dan tetap muncul di laporan. Akun bisa diaktifkan
                  lagi kapan saja.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setToggleUser(null)}>
              Batal
            </Button>
            <Button
              variant={toggleUser?.is_active === false ? "default" : "destructive"}
              onClick={setUserActive}
              disabled={togglingUser}
            >
              {togglingUser && <Loader2 className="mr-2 size-4 animate-spin" />}
              {toggleUser?.is_active === false ? "Ya, Aktifkan" : "Ya, Nonaktifkan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
