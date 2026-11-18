"use client";

// Signed-in nav chip: shows the user's name, signs out on click.

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SignOutButton({ name }: { name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={signOut}
      disabled={busy}
      title="Sign out"
      className="text-[13px] text-[var(--text-dim)] hover:text-[var(--text)] flex items-center gap-1.5"
    >
      <span className="w-5 h-5 rounded-full bg-[var(--accent-dim)] text-[10px] flex items-center justify-center text-white font-bold">
        {name.slice(0, 1).toUpperCase()}
      </span>
      {busy ? "…" : name}
    </button>
  );
}
