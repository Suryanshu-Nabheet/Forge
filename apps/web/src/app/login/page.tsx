"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Two-factor state: after a valid password on a 2FA-enabled account the
  // server responds { totpRequired: true } and we collect the code here.
  const [totpStage, setTotpStage] = useState(false);
  const [code, setCode] = useState("");
  const [recoveryMode, setRecoveryMode] = useState(false);

  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const path = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const payload = mode === "login"
        ? totpStage
          ? recoveryMode
            ? { email, password, recoveryCode: code.trim() }
            : { email, password, code: code.trim() }
          : { email, password }
        : { email, password, name, handle };
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        router.push("/");
        router.refresh();
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string; totpRequired?: boolean };
      if (data.totpRequired) {
        setTotpStage(true);
        setError(null);
        return;
      }
      setError(data.error ?? "request failed");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto mt-16">
      <h1 className="text-lg font-semibold mb-4">
        {totpStage ? "Two-factor code" : mode === "login" ? "Sign in" : "Create account"}
      </h1>
      <div className="card p-5 space-y-4">
        {totpStage ? (
          <>
            <div>
              <label className="text-[13px] text-[var(--text-dim)] block mb-1">
                {recoveryMode ? "Recovery code (one of the codes shown at enrollment)" : "6-digit code from your authenticator"}
              </label>
              <input
                className="input mono"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder={recoveryMode ? "xxxx-xxxx" : "123456"}
                autoFocus
              />
            </div>
            {error && <div className="text-[13px] text-[var(--red)]">{error}</div>}
            <button className="btn btn-primary w-full justify-center" disabled={busy || !code.trim()} onClick={submit}>
              {busy ? "Verifying…" : "Verify"}
            </button>
            <button className="btn w-full justify-center" onClick={() => { setRecoveryMode((v) => !v); setError(null); }}>
              {recoveryMode ? "Use an authenticator code instead" : "Use a recovery code instead"}
            </button>
          </>
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}
