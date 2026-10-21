// Secret scrubbing (SPEC.md, "Data protection"): runs before anything is written
// to the evidence store and again before any LLM call. Findings carry the kind
// and a masked preview only, never the secret itself.

export type SecretKind =
  | "private_key"
  | "anthropic_key"
  | "openai_key"
  | "github_token"
  | "aws_access_key"
  | "slack_token"
  | "stripe_key"
  | "google_api_key"
  | "jwt"
  | "bearer_token"
  | "url_credentials"
  | "env_secret"
  | "assigned_secret";

export interface Finding {
  kind: SecretKind;
  /** First 4 characters and the length, e.g. `sk-a…(108)`: enough to triage a false positive. */
  preview: string;
  /** 1-based line, set by `scrubJsonl`. */
  line?: number;
}

export interface ScrubResult<T> {
  value: T;
  findings: Finding[];
}

const redacted = (kind: SecretKind) => `[REDACTED:${kind}]`;
const isRedacted = (s: string) => s.startsWith("[REDACTED:");
export const mask = (secret: string) => `${secret.slice(0, 4)}…(${secret.length})`;

// Names that mark a value as secret, in env vars (`DB_PASSWORD`), assignments and JSON keys.
// Names that mark a value as secret when they END a key: `DB_PASSWORD`, `apiKey`, `"client_secret"`.
// Not bare `auth`, `pass` or `pwd`: they flag `author`, `bypass` and the shell's `PWD`.
const SECRET_NAME = String.raw`(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|_pass)`;
const SECRET_KEY = new RegExp(String.raw`^[\w.-]*${SECRET_NAME}$`, "i");
// Values that are clearly not secrets: empty, placeholders, template words,
// references to other variables, file paths, version numbers.
const PLACEHOLDER = new RegExp(
  "^(?:" +
    [
      String.raw`|\*+|x+|\.{3}|…|null|none|true|false|undefined`,
      String.raw`change[_-]?me|pass(?:word)?|user(?:name)?|secret|example|your[\w-]*|<.*`,
      String.raw`\\?\$\{?[\w.]+\}?|%\w+%|\{\{.*\}\}|process\.env\.\w+|os\.(?:environ|getenv)\b.*`,
      String.raw`(?:~|\.{1,2})?/[^\s]*`,
      String.raw`v?\d+(?:\.\d+)+[\w.+-]*`,
    ].join("|") +
    ")$",
  "i",
);

interface Rule {
  kind: SecretKind;
  re: RegExp;
  /** Index of the capture group holding the secret; 0 = the whole match. */
  group: number;
}

// Specific formats first, so a key inside an assignment is reported as its own kind.
const RULES: Rule[] = [
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\s|\\n|[A-Za-z0-9+/=:-])+?-----END [A-Z ]*PRIVATE KEY-----/g, group: 0 },
  { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, group: 0 },
  { kind: "openai_key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g, group: 0 },
  { kind: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g, group: 0 },
  { kind: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, group: 0 },
  { kind: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, group: 0 },
  { kind: "stripe_key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g, group: 0 },
  { kind: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, group: 0 },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, group: 0 },
  { kind: "bearer_token", re: /\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/g, group: 1 },
  { kind: "url_credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'<>]+:([^\s@/"'<>]+)@/gi, group: 1 },
  // `.env` lines: `DB_PASSWORD=...`, `export API_TOKEN="..."`. Upper-case names only,
  // so code such as `secret = compute()` is left to the quoted-literal rule below.
  {
    kind: "env_secret",
    re: new RegExp(String.raw`^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*${SECRET_NAME.toUpperCase()}[ \t]*=[ \t]*["']?([^\s"'#]+)`, "gm"),
    group: 1,
  },
  // Quoted literals assigned to a secret-looking name: `password = "..."`, `"api_key": "..."`.
  {
    kind: "assigned_secret",
    re: new RegExp(String.raw`["']?[\w.-]*${SECRET_NAME}["']?[ \t]*[:=][ \t]*(["'])([^"'\s]{4,})\1`, "gi"),
    group: 2,
  },
];

/** Redacts secrets in free text. */
export function scrubText(text: string): ScrubResult<string> {
  const findings: Finding[] = [];
  let out = text;
  for (const { kind, re, group } of RULES) {
    out = out.replace(re, (match: string, ...groups: unknown[]) => {
      const secret = group === 0 ? match : (groups[group - 1] as string | undefined);
      if (!secret || isRedacted(secret) || PLACEHOLDER.test(secret)) return match;
      findings.push({ kind, preview: mask(secret) });
      return group === 0 ? redacted(kind) : match.replace(secret, redacted(kind));
    });
  }
  return { value: out, findings };
}

/**
 * Redacts secrets in every string of a parsed JSON value, plus any string stored
 * under a secret-looking key (`{"password": "..."}`). Returns a new value.
 */
export function scrubJson(value: unknown): ScrubResult<unknown> {
  const findings: Finding[] = [];
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") {
      if (key && SECRET_KEY.test(key) && v.length >= 4 && !isRedacted(v) && !PLACEHOLDER.test(v) && !/\s/.test(v)) {
        findings.push({ kind: "assigned_secret", preview: mask(v) });
        return redacted("assigned_secret");
      }
      const r = scrubText(v);
      findings.push(...r.findings);
      return r.value;
    }
    if (Array.isArray(v)) return v.map((item) => walk(item));
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, walk(item, k)]));
    }
    return v;
  };
  return { value: walk(value), findings };
}

/** Scrubs a JSONL document line by line; a line that is not JSON is scrubbed as text. */
export function scrubJsonl(content: string): ScrubResult<string> {
  const findings: Finding[] = [];
  const lines = content.split("\n").map((line, i) => {
    const at = (fs: Finding[]) => fs.map((f) => ({ ...f, line: i + 1 }));
    if (!line.trim()) return line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      const r = scrubText(line);
      findings.push(...at(r.findings));
      return r.value;
    }
    const r = scrubJson(parsed);
    if (!r.findings.length) return line; // untouched lines stay byte-identical
    findings.push(...at(r.findings));
    return JSON.stringify(r.value);
  });
  return { value: lines.join("\n"), findings };
}
