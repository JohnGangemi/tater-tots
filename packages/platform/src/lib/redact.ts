const PLACEHOLDER = "<redacted>";

const SECRET_FLAGS = new Set([
  "--password",
  "--token",
  "--secret",
  "--key",
  "--api-key",
  "--access-token",
]);

const P_HOSTS = new Set(["mysql", "psql", "sshpass"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GIT_SHA_RE = /^[0-9a-f]{7,40}$/i;
const EXPORT_SECRET_RE = /(TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL)/i;

const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g;
const GHP_RE = /\bghp_[A-Za-z0-9]{36,}\b/g;
const GH_PAT_RE = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const USERINFO_RE = /https?:\/\/[^/\s:@]+:[^/\s@]+@/gi;
const BEARER_RE = /(Authorization:\s*Bearer\s+)\S+/gi;
const BEARER_BARE_RE = /(\bBearer\s+)\S+/g;
const XAPI_RE = /(x-api-key:\s*)\S+/gi;
const BASIC_RE = /(\bBasic\s+)[A-Za-z0-9+/=_-]{8,}/g;

export type RedactResult = {
  argv: string[];
  drop: boolean;
};

function shannonEntropy(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const ch of value) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function looksLikePath(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("~") || value.startsWith(".")) {
    return true;
  }
  if (value.includes("/") || value.includes("\\")) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return true;
  }
  return false;
}

function isUncertainSecret(value: string): boolean {
  if (value.length < 20) {
    return false;
  }
  if (GIT_SHA_RE.test(value) || UUID_RE.test(value) || looksLikePath(value)) {
    return false;
  }
  return shannonEntropy(value) >= 3.5;
}

function flagName(token: string): string {
  const eq = token.indexOf("=");
  const raw = eq === -1 ? token : token.slice(0, eq);
  return raw.toLowerCase();
}

function hostBase(token: string | undefined): string {
  if (!token) {
    return "";
  }
  const slash = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  const base = slash === -1 ? token : token.slice(slash + 1);
  return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

function applyPatterns(text: string): { text: string; hit: boolean } {
  let hit = false;
  let s = text;
  const replaceAll = (re: RegExp, repl: string | ((m: string) => string)): void => {
    s = s.replace(re, (m) => {
      hit = true;
      return typeof repl === "string" ? repl : repl(m);
    });
  };
  replaceAll(PEM_RE, PLACEHOLDER);
  replaceAll(AWS_KEY_RE, PLACEHOLDER);
  replaceAll(GHP_RE, PLACEHOLDER);
  replaceAll(GH_PAT_RE, PLACEHOLDER);
  replaceAll(JWT_RE, PLACEHOLDER);
  replaceAll(USERINFO_RE, (m) => {
    const idx = m.indexOf("://");
    const proto = idx === -1 ? "" : m.slice(0, idx + 3);
    return `${proto}${PLACEHOLDER}@`;
  });
  replaceAll(BEARER_RE, `$1${PLACEHOLDER}`);
  replaceAll(BEARER_BARE_RE, `$1${PLACEHOLDER}`);
  replaceAll(XAPI_RE, `$1${PLACEHOLDER}`);
  replaceAll(BASIC_RE, `$1${PLACEHOLDER}`);
  return { text: s, hit };
}

function hasBinary(argv: string[]): boolean {
  return argv.some((t) => t.includes("\0"));
}

function redactExport(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "export") {
      continue;
    }
    const next = argv[i + 1];
    if (!next) {
      continue;
    }
    const eq = next.indexOf("=");
    const name = eq === -1 ? next : next.slice(0, eq);
    if (EXPORT_SECRET_RE.test(name)) {
      return true;
    }
  }
  return false;
}

export function redactArgv(argv: string[]): RedactResult {
  try {
    if (hasBinary(argv)) {
      return { argv: argv.map(() => PLACEHOLDER), drop: true };
    }
    let drop = false;
    const out = argv.slice();

    for (let i = 0; i < out.length; i++) {
      const tok = out[i];
      if (tok === undefined) {
        continue;
      }
      const name = flagName(tok);
      if (SECRET_FLAGS.has(name)) {
        drop = true;
        const eq = tok.indexOf("=");
        if (eq !== -1) {
          out[i] = `${tok.slice(0, eq + 1)}${PLACEHOLDER}`;
        } else if (i + 1 < out.length) {
          const next = out[i + 1];
          if (next !== undefined && !next.startsWith("-")) {
            out[i + 1] = PLACEHOLDER;
            i += 1;
          }
        }
        continue;
      }
      const prev = hostBase(out[i - 1]);
      if (P_HOSTS.has(prev) && (name === "-p" || /^-(p|-password)$/i.test(name))) {
        drop = true;
        if (tok.startsWith("-p") && tok.length > 2 && !tok.startsWith("--")) {
          out[i] = `-p${PLACEHOLDER}`;
        } else if (i + 1 < out.length) {
          out[i + 1] = PLACEHOLDER;
          i += 1;
        }
      }
    }

    for (let i = 0; i < out.length; i++) {
      const tok = out[i];
      if (tok === undefined || !tok.startsWith("--") || tok === "--") {
        continue;
      }
      const name = flagName(tok);
      if (SECRET_FLAGS.has(name)) {
        continue;
      }
      const eq = tok.indexOf("=");
      if (eq !== -1) {
        const value = tok.slice(eq + 1);
        if (isUncertainSecret(value)) {
          drop = true;
          out[i] = `${tok.slice(0, eq + 1)}${PLACEHOLDER}`;
        }
        continue;
      }
      const next = out[i + 1];
      if (next !== undefined && !next.startsWith("-") && isUncertainSecret(next)) {
        drop = true;
        out[i + 1] = PLACEHOLDER;
        i += 1;
      }
    }

    if (redactExport(argv)) {
      drop = true;
    }

    for (let i = 0; i < out.length; i++) {
      const tok = out[i];
      if (tok === undefined) {
        continue;
      }
      const patterned = applyPatterns(tok);
      if (patterned.hit) {
        drop = true;
        out[i] = patterned.text;
      }
    }

    const joined = applyPatterns(out.join(" "));
    if (joined.hit) {
      drop = true;
    }

    return { argv: out, drop };
  } catch {
    return { argv: argv.map(() => PLACEHOLDER), drop: true };
  }
}

export function redactText(text: string): string {
  try {
    if (text.includes("\0")) {
      return PLACEHOLDER;
    }
    let s = applyPatterns(text).text;
    s = s.replace(
      /--(password|token|secret|key|api-key|access-token)(=|\s+)\S+/gi,
      `--$1$2${PLACEHOLDER}`,
    );
    return s;
  } catch {
    return PLACEHOLDER;
  }
}
