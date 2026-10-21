// Secret scrubbing (SPEC.md, "Data protection"): runs before anything is written
// to the evidence store and again before any LLM call. Findings carry the kind
// and a masked preview only, never the secret itself.

export type SecretKind =
  | "private_key"
  | "anthropic_key"
  | "openai_key"
  | "github_token"
  | "service_token"
  | "aws_access_key"
  | "slack_token"
  | "stripe_key"
  | "google_api_key"
  | "jwt"
  | "auth_header"
  | "url_credentials"
  | "cli_password"
  | "env_secret"
  | "assigned_secret";

export interface Finding {
  kind: SecretKind;
  /** A few leading characters and the length, e.g. `sk-a…(108)`: enough to triage a false positive. */
  preview: string;
  /** 1-based line, set for JSONL. */
  line?: number;
}

export interface ScrubResult<T> {
  value: T;
  findings: Finding[];
}

const redacted = (kind: SecretKind) => `[REDACTED:${kind}]`;
const isRedacted = (s: string) => s.startsWith("[REDACTED:");
/** Shows at most a quarter of the secret, and never more than 4 characters. */
export const mask = (secret: string) => `${secret.slice(0, Math.min(4, Math.floor(secret.length / 4)))}…(${secret.length})`;

// Names that mark a value as secret when they END a key: `DB_PASSWORD`, `apiKey`, `"client_secret"`.
// Not bare `auth`, `pass` or `pwd`: they flag `author`, `bypass` and the shell's `PWD`.
const SECRET_NAME = String.raw`(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|_pass)`;
const SECRET_KEY = new RegExp(String.raw`^[\w.-]*${SECRET_NAME}$`, "i");
// Names whose values are often not secret (`"credentials": "include"`, `token: "use-cookie"`):
// their values must also look random.
const WEAK_NAME = /(?:token|credentials?)$/i;
const PASSWORD_NAME = /(?:password|passwd|passphrase|_pass)$/i;

// Values that are clearly not secrets: empty, placeholders, template words, file paths,
// version numbers, type names, references to other variables. Variable references are
// matched case-sensitively, so a password such as `$ecret1` is not mistaken for `$SECRET`.
const PLACEHOLDER = new RegExp(
  "^(?:" +
    [
      String.raw`|\*+|x+|\.{3}|…|null|none|nil|true|false|undefined`,
      String.raw`change[_-]?me|pass(?:word)?|user(?:name)?|secret|example|your[\w-]*|<.*`,
      String.raw`process\.env\.\w+|os\.(?:environ|getenv)\b.*|env\(.*`,
      String.raw`(?:~|\.{1,2})?/[^\s]*`,
      String.raw`v?\d+(?:\.\d+)+[\w.+-]*`,
      String.raw`str|string|int|integer|number|bool|boolean|bytes|any|unknown|optional\[.*|secretstr`,
    ].join("|") +
    ")$",
  "i",
);
const VARIABLE_REF = /^(?:\\?\$\{\{.*\}\}|\\?\$\{[\w.:-]+\}|\$[A-Z_][A-Z0-9_]*|%[A-Z_][A-Z0-9_]*%|\{\{.*\}\})$/;

/** Random-looking: a digit, mixed case with at least two capitals, or two base64/punctuation marks. */
const looksRandom = (v: string) => /\d/.test(v) || (/[A-Z].*[A-Z]/.test(v) && /[a-z]/.test(v)) || /[+/=_-].*[+/=_-]/.test(v);

/** Code rather than a value: calls, indexing, member access, or a trailing `;`, `,` or `{`. */
const looksLikeCode = (v: string) => /[([]/.test(v) || /[;,{]$/.test(v) || /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(v);

/** Whether `value`, assigned to a key named `name`, should be treated as a secret. */
function isSecretValue(value: string, name?: string): boolean {
  const v = value.trim();
  if (v.length < 4 || isRedacted(v) || PLACEHOLDER.test(v) || VARIABLE_REF.test(v)) return false;
  if (name && WEAK_NAME.test(name) && (!looksRandom(v) || /\s/.test(v))) return false;
  return true;
}

interface Span {
  start: number;
  end: number;
}

interface Rule {
  kind: SecretKind;
  /** Must carry the `d` and `g` flags. */
  re: RegExp;
  /** The span of the secret within the match, or null to keep the match as it is. */
  pick: (m: RegExpExecArray) => Span | null;
}

const group =
  (...groups: number[]) =>
  (m: RegExpExecArray): Span | null => {
    for (const g of groups) {
      const at = m.indices?.[g];
      if (at) return { start: at[0], end: at[1] };
    }
    return null;
  };
const whole = group(0);

// Patterns that could start anywhere inside a run of word characters carry a
// lookbehind, so a long run costs linear time instead of quadratic.
const RULES: Rule[] = [
  // A key body needs a real base64 run, so code that only mentions the markers is kept.
  {
    kind: "private_key",
    re: /-----BEGIN ([A-Z ]*)PRIVATE KEY-----(?=[\s\S]{0,400}?[A-Za-z0-9+/]{40})[\s\S]*?-----END \1PRIVATE KEY-----/dg,
    pick: whole,
  },
  // A truncated paste: the BEGIN line, optional headers and base64 lines, no END line.
  {
    kind: "private_key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[ \t]*(?:\r?\n|\\r?\\n)(?:[A-Za-z][\w-]*:[^\n\\]*|[A-Za-z0-9+/=]{16,}))+/dg,
    pick: (m) => (/[A-Za-z0-9+/]{40}/.test(m[0]) ? whole(m) : null),
  },
  { kind: "anthropic_key", re: /(?<![\w-])sk-ant-[A-Za-z0-9_-]{20,}/dg, pick: whole },
  { kind: "openai_key", re: /(?<![\w-])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/dg, pick: whole },
  { kind: "github_token", re: /(?<!\w)(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/dg, pick: whole },
  {
    kind: "service_token",
    re: /(?<![\w.-])(?:glpat-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{36,}|ya29\.[A-Za-z0-9_-]{20,})/dg,
    pick: whole,
  },
  { kind: "aws_access_key", re: /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/dg, pick: whole },
  { kind: "slack_token", re: /(?<![\w-])xox[abprs]-[A-Za-z0-9-]{10,}/dg, pick: whole },
  { kind: "stripe_key", re: /(?<!\w)(?:sk|rk)_live_[A-Za-z0-9]{16,}/dg, pick: whole },
  { kind: "google_api_key", re: /(?<![\w-])AIza[0-9A-Za-z_-]{35}(?![\w-])/dg, pick: whole },
  { kind: "jwt", re: /(?<![\w-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/dg, pick: whole },
  {
    kind: "auth_header",
    re: /\b(?:Bearer|Basic)[ \t]+([A-Za-z0-9._~+/-]{8,}=*)/dgi,
    pick: (m) => (looksRandom(m[1] ?? "") ? group(1)(m) : null),
  },
  // scheme://user:password@host; the user may be empty (`redis://:pw@host`).
  {
    kind: "url_credentials",
    re: /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'<>]*:([^\s@/"'<>]+)@/dgi,
    pick: (m) => (isSecretValue(m[1] ?? "") ? group(1)(m) : null),
  },
  // Passwords on a command line: `mysql -pX`, `curl -u user:X`, `sshpass -p X`, `--password=X`.
  { kind: "cli_password", re: /\b(?:mysql|mysqldump|mariadb)\b[^\n]*?[ \t]-p([^\s"'-][^\s"']*)/dg, pick: group(1) },
  { kind: "cli_password", re: /\bcurl\b[^\n]*?[ \t](?:-u|--user)[ \t]+["']?[^\s:"']*:([^\s"']+)/dg, pick: group(1) },
  { kind: "cli_password", re: /\bsshpass[ \t]+-p[ \t]*["']?([^\s"']+)/dg, pick: group(1) },
  {
    kind: "cli_password",
    re: /--password(?:=|[ \t]+)(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"'-]\S*))/dg,
    pick: (m) => (isSecretValue(m[1] ?? m[2] ?? m[3] ?? "") ? group(1, 2, 3)(m) : null),
  },
  // Config lines (.env, YAML, TOML, INI, ~/.aws/credentials): `DB_PASSWORD=x`, `password: x`,
  // `aws_secret_access_key = x`. An unquoted value runs to the end of the line, minus a ` # comment`.
  {
    kind: "env_secret",
    re: new RegExp(
      String.raw`^[ \t]*(?:export[ \t]+|-[ \t]+)?["']?([\w.-]*${SECRET_NAME})["']?[ \t]*[:=][ \t]*` +
        String.raw`(?:"([^"\n]*)"|'([^'\n]*)'|([^\s#"'](?:[^\n]*?[^\s])?))[ \t]*(?:[ \t]#[^\n]*)?\r?$`,
      "dgim",
    ),
    pick: (m) => {
      const unquoted = m[4];
      if (unquoted !== undefined && (looksLikeCode(unquoted) || (/\s/.test(unquoted) && !looksRandom(unquoted)))) return null;
      return isSecretValue(m[2] ?? m[3] ?? unquoted ?? "", m[1]) ? group(2, 3, 4)(m) : null;
    },
  },
  // Quoted literals anywhere: `password = "..."`, `"api_key": "..."`, `{ token: 'ab12...' }`.
  {
    kind: "assigned_secret",
    re: new RegExp(String.raw`(?<![\w.-])["']?([\w.-]*${SECRET_NAME})["']?[ \t]*[:=][ \t]*(["'])((?:(?!\2)[^\n\\]|\\.){4,}?)\2`, "dgi"),
    pick: (m) => (isSecretValue(m[3] ?? "", m[1]) ? group(3)(m) : null),
  },
];

/** Redacts secrets in free text. */
export function scrubText(text: string): ScrubResult<string> {
  const findings: Finding[] = [];
  let out = text;
  for (const rule of RULES) {
    const spans: Span[] = [];
    for (const m of out.matchAll(rule.re)) {
      const span = rule.pick(m);
      if (!span || span.end <= span.start) continue;
      const secret = out.slice(span.start, span.end);
      if (isRedacted(secret)) continue;
      spans.push(span);
      findings.push({ kind: rule.kind, preview: mask(secret) });
    }
    // Splice by position, last first, so earlier offsets stay valid.
    for (const { start, end } of spans.reverse()) out = out.slice(0, start) + redacted(rule.kind) + out.slice(end);
  }
  return { value: out, findings };
}

/** Scrubs one string value; `key` is the JSON key it sits under, if any. */
function scrubString(value: string, key?: string): ScrubResult<string> {
  if (key && SECRET_KEY.test(key) && isSecretValue(value, key)) {
    return { value: redacted("assigned_secret"), findings: [{ kind: "assigned_secret", preview: mask(value) }] };
  }
  return scrubText(value);
}

/** Redacts secrets in every string of a parsed JSON value (and under secret-looking keys). Returns a new value. */
export function scrubJson(value: unknown): ScrubResult<unknown> {
  const findings: Finding[] = [];
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") {
      const r = scrubString(v, key);
      findings.push(...r.findings);
      return r.value;
    }
    if (typeof v === "number" && key && PASSWORD_NAME.test(key)) {
      findings.push({ kind: "assigned_secret", preview: mask(String(v)) });
      return redacted("assigned_secret");
    }
    if (Array.isArray(v)) return v.map((item) => walk(item));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, walk(item, k)]));
    return v;
  };
  return { value: walk(value), findings };
}

/**
 * Scrubs a JSON document in place: only the string tokens (and numbers under
 * password keys) that hold a secret are rewritten, so every other byte is kept —
 * large integers, `1.0`, duplicate keys, key order, whitespace and line endings.
 * Returns null when `source` is not valid JSON.
 */
export function scrubJsonSource(source: string): ScrubResult<string> | null {
  try {
    JSON.parse(source);
  } catch {
    return null;
  }
  const findings: Finding[] = [];
  const parts: string[] = [];
  let copied = 0;
  const splice = (start: number, end: number, text: string) => {
    parts.push(source.slice(copied, start), text);
    copied = end;
  };
  let key: string | undefined; // the last object key read
  let afterColon = false; // the next value belongs to `key`
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === '"') {
      let j = i + 1;
      while (source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
      const token = source.slice(i, j + 1);
      let k = j + 1;
      while (k < source.length && " \t\r\n".includes(source[k]!)) k++;
      if (!afterColon && source[k] === ":") {
        key = JSON.parse(token) as string;
      } else {
        const r = scrubString(JSON.parse(token) as string, afterColon ? key : undefined);
        if (r.findings.length) {
          findings.push(...r.findings);
          splice(i, j + 1, JSON.stringify(r.value));
        }
        afterColon = false;
      }
      i = j + 1;
    } else if (c === ":") {
      afterColon = true;
      i++;
    } else if (c === "-" || (c >= "0" && c <= "9")) {
      let j = i + 1;
      while (j < source.length && /[\d.eE+-]/.test(source[j]!)) j++;
      if (afterColon && key && PASSWORD_NAME.test(key)) {
        findings.push({ kind: "assigned_secret", preview: mask(source.slice(i, j)) });
        splice(i, j, JSON.stringify(redacted("assigned_secret")));
      }
      afterColon = false;
      i = j;
    } else {
      if (!" \t\r\n".includes(c)) afterColon = false; // `{`, `[`, `,`, `}`, `]`, true/false/null
      i++;
    }
  }
  parts.push(source.slice(copied));
  return { value: parts.join(""), findings };
}

/** Scrubs a JSONL document line by line; a line that is not JSON is scrubbed as text. */
export function scrubJsonl(content: string): ScrubResult<string> {
  const findings: Finding[] = [];
  const lines = content.split("\n").map((line, i) => {
    if (!line.trim()) return line;
    const r = scrubJsonSource(line) ?? scrubText(line);
    findings.push(...r.findings.map((f) => ({ ...f, line: i + 1 })));
    return r.value;
  });
  return { value: lines.join("\n"), findings };
}
