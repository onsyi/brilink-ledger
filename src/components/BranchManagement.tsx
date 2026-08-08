import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Plus, Pencil, Trash2, Building2, CheckCircle2, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Branch = {
  id: string;
  name: string;
  address: string | null;
  is_active: boolean;
  created_at: string;
};

export function BranchManagement() {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editBranch, setEditBranch] = useState<Branch | null>(null);
  const [deleteBranch, setDeleteBranch] = useState<Branch | null>(null);

  const branches = useQuery({
    queryKey: ["branches"],
    queryFn: async () => {
      const { data, error } = await supabase.from("branches").select("*").order("name");
      if (error) throw error;
      return (data ?? []) as Branch[];
    },
  });

  const invalidateAllBranchQueries = () => {
    queryClient.invalidateQueries({ queryKey: ["branches"] });
    queryClient.invalidateQueries({ queryKey: ["owner-overview"] });
    queryClient.invalidateQueries({ queryKey: ["shift-reports"] });
    queryClient.invalidateQueries({ queryKey: ["open-shift"] });
  };

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("branches").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Cabang dihapus");
      invalidateAllBranchQueries();
      setDeleteBranch(null);
    },
    onError: (err: Error) => {
      toast.error(
        err.message.includes("foreign key")
          ? "Cabang masih digunakan oleh shift atau kasir. Nonaktifkan cabang daripada menghapus."
          : err.message,
      );
    },
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase.from("branches").update({ is_active }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_, variables) => {
      toast.success(
        variables.is_active ? "Cabang berhasil diaktifkan kembali" : "Cabang telah dinonaktifkan",
      );
      invalidateAllBranchQueries();
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  if (branches.isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-5 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-xl bg-primary/15">
            <Building2 className="size-5 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-bold">Manajemen Cabang</h2>
            <p className="text-xs text-muted-foreground">
              Kelola outlet dan status keaktifan cabang
            </p>
          </div>
        </div>
        <Button size="sm" onClick={() => setShowAdd(true)}>
          <Plus className="mr-1.5 size-4" />
          Tambah Cabang
        </Button>
      </div>

      {!branches.data || branches.data.length === 0 ? (
        <div className="rounded-2xl border border-border/40 bg-secondary/20 py-8 text-center text-sm text-muted-foreground">
          Belum ada cabang. Tambah cabang untuk memulai organisasi.
        </div>
      ) : (
        <div className="space-y-2.5">
          {branches.data.map((b) => (
            <div
              key={b.id}
              className={`flex items-center justify-between rounded-2xl border p-4 backdrop-blur-sm transition-all ${
                b.is_active
                  ? "border-border/60 bg-secondary/30 hover:border-primary/30"
                  : "border-destructive/20 bg-destructive/5 opacity-75"
              }`}
            >
              <div className="flex items-center gap-3.5">
                <div
                  className={`flex size-10 items-center justify-center rounded-xl font-bold text-sm ${
                    b.is_active
                      ? "bg-primary/15 text-primary"
                      : "bg-secondary text-muted-foreground"
                  }`}
                >
                  {b.name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">{b.name}</span>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                        b.is_active
                          ? "bg-success/15 text-success border border-success/25"
                          : "bg-destructive/15 text-destructive border border-destructive/25"
                      }`}
                    >
                      {b.is_active ? (
                        <>
                          <CheckCircle2 className="size-3" /> Aktif
                        </>
                      ) : (
                        <>
                          <XCircle className="size-3" /> Nonaktif
                        </>
                      )}
                    </span>
                  </div>
                  {b.address && <p className="mt-0.5 text-xs text-muted-foreground">{b.address}</p>}
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant={b.is_active ? "outline" : "default"}
                  disabled={toggleActive.isPending}
                  onClick={() => toggleActive.mutate({ id: b.id, is_active: !b.is_active })}
                  className="text-xs"
                >
                  {b.is_active ? "Nonaktifkan" : "Aktifkan"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditBranch(b)}>
                  <Pencil className="size-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDeleteBranch(b)}
                  className="text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showAdd && <BranchForm onClose={() => setShowAdd(false)} />}
      {editBranch && <BranchForm branch={editBranch} onClose={() => setEditBranch(null)} />}
      {deleteBranch && (
        <Dialog open onOpenChange={() => setDeleteBranch(null)}>
          <DialogContent className="glass-card border-white/20">
            <DialogHeader>
              <DialogTitle className="font-display text-xl font-bold">Hapus Cabang</DialogTitle>
              <DialogDescription>
                Yakin ingin menghapus{" "}
                <span className="font-bold text-foreground">{deleteBranch.name}</span>? Jika cabang
                memiliki riwayat shift, disarankan untuk **Menonaktifkan** cabang daripada
                menghapusnya.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="mt-4">
              <Button variant="outline" onClick={() => setDeleteBranch(null)}>
                Batal
              </Button>
              <Button
                variant="destructive"
                onClick={() => deleteMutation.mutate(deleteBranch.id)}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                Hapus Cabang
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function BranchForm({ branch, onClose }: { branch?: Branch; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(branch?.name ?? "");
  const [address, setAddress] = useState(branch?.address ?? "");

  const invalidateAllBranchQueries = () => {
    queryClient.invalidateQueries({ queryKey: ["branches"] });
    queryClient.invalidateQueries({ queryKey: ["owner-overview"] });
    queryClient.invalidateQueries({ queryKey: ["shift-reports"] });
  };

  const upsert = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Nama cabang wajib diisi");
      if (branch) {
        const { error } = await supabase
          .from("branches")
          .update({ name: name.trim(), address: address.trim() || null })
          .eq("id", branch.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("branches")
          .insert({ name: name.trim(), address: address.trim() || null, is_active: true });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(branch ? "Cabang diperbarui" : "Cabang ditambahkan");
      invalidateAllBranchQueries();
      onClose();
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="glass-card border-white/20">
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-bold">
            {branch ? "Edit Cabang" : "Tambah Cabang Baru"}
          </DialogTitle>
          <DialogDescription>
            {branch
              ? "Perbarui nama dan alamat cabang."
              : "Buat cabang outlet baru untuk organisasi Anda."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="branch-name" className="text-xs font-semibold text-muted-foreground">
              Nama Cabang
            </Label>
            <Input
              id="branch-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Contoh: Cabang Utama / Cabang Pasar"
              maxLength={100}
              className="h-11 transition-all focus-visible:ring-primary/50"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="branch-address" className="text-xs font-semibold text-muted-foreground">
              Alamat Cabang (opsional)
            </Label>
            <Input
              id="branch-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Jl. Merdeka No. 12"
              maxLength={255}
              className="h-11 transition-all focus-visible:ring-primary/50"
            />
          </div>
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>
            Batal
          </Button>
          <Button onClick={() => upsert.mutate()} disabled={upsert.isPending}>
            {upsert.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
            {branch ? "Simpan" : "Tambah"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
