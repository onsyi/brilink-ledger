import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Plus, Pencil, Trash2, Building2 } from "lucide-react";
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

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("branches").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Cabang dihapus");
      queryClient.invalidateQueries({ queryKey: ["branches"] });
      setDeleteBranch(null);
    },
    onError: (err: Error) => {
      toast.error(
        err.message.includes("foreign key")
          ? "Cabang masih digunakan oleh shift atau user"
          : err.message,
      );
    },
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase.from("branches").update({ is_active }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["branches"] });
    },
  });

  if (branches.isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Building2 className="size-5 text-primary" />
          <h2 className="text-lg font-semibold">Manajemen Cabang</h2>
        </div>
        <Button size="sm" onClick={() => setShowAdd(true)}>
          <Plus className="mr-1 size-3" />
          Tambah Cabang
        </Button>
      </div>

      {!branches.data || branches.data.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Belum ada cabang. Tambah cabang untuk memulai.
        </p>
      ) : (
        <div className="space-y-2">
          {branches.data.map((b) => (
            <div
              key={b.id}
              className="flex items-center justify-between rounded-lg border border-border p-3"
            >
              <div className="flex items-center gap-3">
                <div className="flex size-9 items-center justify-center rounded-lg bg-secondary text-sm font-bold">
                  {b.name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{b.name}</span>
                    <Badge variant={b.is_active ? "default" : "secondary"}>
                      {b.is_active ? "Aktif" : "Nonaktif"}
                    </Badge>
                  </div>
                  {b.address && <p className="mt-0.5 text-xs text-muted-foreground">{b.address}</p>}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => toggleActive.mutate({ id: b.id, is_active: !b.is_active })}
                >
                  {b.is_active ? "Nonaktifkan" : "Aktifkan"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditBranch(b)}>
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDeleteBranch(b)}
                  className="text-destructive"
                >
                  <Trash2 className="size-3.5" />
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
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Hapus Cabang</DialogTitle>
              <DialogDescription>
                Yakin ingin menghapus <span className="font-medium">{deleteBranch.name}</span>?
                Shift dan user yang terkait cabang ini akan kehilangan referensi.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setDeleteBranch(null)}>
                Batal
              </Button>
              <Button
                variant="destructive"
                onClick={() => deleteMutation.mutate(deleteBranch.id)}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                Hapus
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
          .insert({ name: name.trim(), address: address.trim() || null });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(branch ? "Cabang diperbarui" : "Cabang ditambahkan");
      queryClient.invalidateQueries({ queryKey: ["branches"] });
      onClose();
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{branch ? "Edit Cabang" : "Tambah Cabang"}</DialogTitle>
          <DialogDescription>
            {branch ? "Perbarui informasi cabang." : "Buat cabang baru untuk organisasi."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="branch-name">Nama Cabang</Label>
            <Input
              id="branch-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Cabang Pusat"
              maxLength={100}
              className="h-11"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="branch-address">Alamat (opsional)</Label>
            <Input
              id="branch-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Jl. Contoh No. 1"
              maxLength={255}
              className="h-11"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
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
