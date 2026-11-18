"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const path = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const payload = mode === "login"
        ? { email, password }
        : { email, password, name, handle };
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        router.push("/");
        router.refresh();
      } else {
        const data = await res.json();
        setError(data.error ?? "request failed");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto mt-16">
      <h1 className="text-lg font-semibold mb-4">{mode === "login" ? "Sign in" : "Create account"}</h1>
      <div className="card p-5 space-y-4">
        <div>
          <label className="text-[13px] text-[var(--text-dim)] block mb-1">Email</label>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ada@acme.dev" />
        </div>
        {mode === "register" && (
          <>
            <div>
              <label className="text-[13px] text-[var(--text-dim)] block mb-1">Name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" />
            </div>
            <div>
              <label className="text-[13px] text-[var(--text-dim)] block mb-1">Handle</label>
              <input className="input mono" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="ada" />
            </div>
          </>
        )}
        <div>
          <label className="text-[13px] text-[var(--text-dim)] block mb-1">Password</label>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()} />
        </div>
        {error && <div className="text-[13px] text-[var(--red)]">{error}</div>}
        <button className="btn btn-primary w-full justify-center" disabled={busy || !email || !password} onClick={submit}>
          {busy ? "Working…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
        <button className="btn w-full justify-center" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }}>
          {mode === "login" ? "Need an account? Register" : "Have an account? Sign in"}
        </button>
        {mode === "login" && <p className="text-xs text-[var(--text-faint)]">Seeded demo: ada@acme.dev / password123</p>}
      </div>
    </div>
  );
}
