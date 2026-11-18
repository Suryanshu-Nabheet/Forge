// Lifecycle-script prescan: block dangerous npm lifecycle scripts before running builds.

const DANGEROUS_SCRIPT_RE = [
  /\bcurl\b[^|]*\|\s*(ba)?sh\b/i,
  /\bwget\b[^|]*\|\s*(ba)?sh\b/i,
  /\/dev\/tcp/i,
  /\beval\b\s*["'].*(curl|wget)/i,
  /\bnc\s+-e\b/i,
  /\bbash\s+-c\s*["'][^"']*(curl|wget|http)/i,
];

export interface ScanResult {
  ok: boolean;
  reason?: string;
}

/** Scan a package.json's scripts for remote-code-execution patterns. */
export function scanPackageJson(raw: string | null): ScanResult {
  if (!raw) return { ok: true };
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(raw);
  } catch {
    return { ok: true }; // malformed package.json will fail the build anyway
  }
  const scripts = pkg.scripts ?? {};
  for (const [name, script] of Object.entries(scripts)) {
    for (const re of DANGEROUS_SCRIPT_RE) {
      if (re.test(script)) {
        return { ok: false, reason: `lifecycle script "${name}" runs remote code: ${script.slice(0, 120)}` };
      }
    }
  }
  return { ok: true };
}
