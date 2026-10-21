import { describe, expect, it } from "vitest";
import { type SecretKind, mask, scrubJson, scrubJsonSource, scrubJsonl, scrubText } from "../src/scrub.js";

// Planted secrets, assembled at runtime so no real-looking token sits in the repo.
const S = {
  anthropic: "sk-ant-" + "api03-" + "A1b2".repeat(20),
  openai: "sk-" + "proj-" + "Zx9".repeat(16),
  github: "gh" + "p_" + "Q".repeat(36),
  githubPat: "github" + "_pat_" + "11ABC" + "d".repeat(30),
  gitlab: "gl" + "pat-" + "x7Y8z9".repeat(4),
  huggingface: "h" + "f_" + "AbCdEfGh".repeat(5),
  npm: "np" + "m_" + "N0pQ".repeat(10),
  googleOauth: "ya" + "29." + "a0AfH6SM".repeat(4),
  aws: "AK" + "IA" + "IOSFODNN7EXAMPLE",
  slack: "xo" + "xb-" + "1234567890-abcdefghij",
  stripe: "sk" + "_live_" + "4eC39HqLyjWDarjtT1zdp7dc",
  google: "AI" + "za" + "S".repeat(35),
  jwt: "eyJ" + "hbGciOiJIUzI1NiJ9" + ".eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0" + ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  pemBody: "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ",
  bearer: "abcDEF123456" + "ghiJKL789xyz",
  urlPassword: "S3cr3t" + "Passw0rd",
  envPassword: "hunter2" + "hunter2",
  envSecret: "whsec_" + "abcdef123456",
  envToken: "tok_" + "9f8e7d6c5b",
  assigned: "correct-horse-" + "battery",
  clientSecret: "cs_" + "123456789",
  jsonKey: "k-" + "1234567890",
};

const PLANTED = `
Keys: ${S.anthropic} and ${S.openai}, then ${S.github} / ${S.githubPat}.
Also ${S.gitlab}, ${S.huggingface}, ${S.npm} and ${S.googleOauth}.
AWS ${S.aws}, Slack ${S.slack}, Stripe ${S.stripe}, Google ${S.google}.
JWT ${S.jwt}
-----BEGIN OPENSSH PRIVATE KEY-----
${S.pemBody}
-----END OPENSSH PRIVATE KEY-----
curl -H "Authorization: Bearer ${S.bearer}" https://api.example.com
DATABASE_URL=postgres://brain:${S.urlPassword}@db.local:5432/brain
DB_PASSWORD=${S.envPassword}
export STRIPE_SECRET="${S.envSecret}"
API_TOKEN=${S.envToken}
password = "${S.assigned}"
{"client_secret": "${S.clientSecret}"}
`;

// Text that looks close to a secret but is not one; it must come through untouched.
const BENIGN = `
interface Login { password: string; token?: string }
const token = getToken();
password = self.password
PORT=3000
NODE_ENV=production
PWD=/home/kdegroise/dev
API_KEY=\${API_KEY}
GITHUB_TOKEN=\${{ secrets.GITHUB_TOKEN }}
SECRET_TOKEN=<your token here>
The tool result cap is 25k tokens; set max_tokens accordingly.
commit 5412132d8500a7029ae7645369134499c4764741, session 4e72e044-0bd2-40ea-afbf-fa36accc5e46
tokenize = 'unicode61 remove_diacritics 2'
author: "Kylian"
{"permissionMode":"bypassPermissions","input_tokens":1234}
Send a Bearer token in the Authorization header. Basic authentication is off.
password: "[REDACTED:assigned_secret]"
{"hostCredential":"/home/kdegroise/.config/gh/hosts.yml"}
credentials = "1.5.0"
fetch(url, { credentials: "include" })
authToken: "use-cookie"
- password: use a strong one
- password: must be at least 12 characters
Secret: 3 things matter here
mysql -u root appdb; mkdir -pv backups
curl -u "$USER:$PASS" https://x.local
const PEM_START = "-----BEGIN RSA PRIVATE KEY-----"; // commit 5412132d8500a7029ae7645369134499c4764741
const PEM_END = "-----END RSA PRIVATE KEY-----";
sqlalchemy.url = driver://user:pass@localhost/dbname
MATOMO_DB_PASSWORD=change-me
secret = stockage.read_key()
re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
`;

const secretValues = () => Object.values(S);

describe("scrubText", () => {
  it("removes every planted secret and names its kind", () => {
    const { value, findings } = scrubText(PLANTED);
    for (const secret of secretValues()) expect(value).not.toContain(secret);
    const kinds = new Set(findings.map((f) => f.kind));
    const expected: SecretKind[] = [
      "private_key", "anthropic_key", "openai_key", "github_token", "service_token", "aws_access_key", "slack_token",
      "stripe_key", "google_api_key", "jwt", "auth_header", "url_credentials", "env_secret", "assigned_secret",
    ];
    for (const k of expected) expect(kinds).toContain(k);
  });

  // Each case: input → exact output. Covers the shapes the PR #17 review found leaking.
  it.each([
    ["password equal to the user and scheme", "postgres://postgres:postgres@localhost", "postgres://postgres:[REDACTED:url_credentials]@localhost"],
    ["empty URL user", "redis://:pw0rd123@cache:6379", "redis://:[REDACTED:url_credentials]@cache:6379"],
    ["YAML", "    POSTGRES_PASSWORD: s3cretYaml", "    POSTGRES_PASSWORD: [REDACTED:env_secret]"],
    ["lower-case YAML", "password: hunter2hunter2", "password: [REDACTED:env_secret]"],
    ["AWS credentials file", "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG", "aws_secret_access_key = [REDACTED:env_secret]"],
    ["lower-case .env", "db_password=lowercase9", "db_password=[REDACTED:env_secret]"],
    ["# inside a value", "DB_PASSWORD=abc#rest", "DB_PASSWORD=[REDACTED:env_secret]"],
    ["trailing comment", "DB_PASSWORD=abc123 # dev only", "DB_PASSWORD=[REDACTED:env_secret] # dev only"],
    ["quoted value with spaces", 'DB_PASSWORD="a b c d"', 'DB_PASSWORD="[REDACTED:env_secret]"'],
    ["quoted passphrase inline", 'login(password = "correct horse battery staple")', 'login(password = "[REDACTED:assigned_secret]")'],
    ["value starting with $", "DB_PASSWORD=$ecret99", "DB_PASSWORD=[REDACTED:env_secret]"],
    ["numeric password", "password: 123456", "password: [REDACTED:env_secret]"],
    ["Basic auth", "Authorization: Basic dXNlcjpwYXNzd29yZA==", "Authorization: Basic [REDACTED:auth_header]"],
    ["lower-case bearer", "authorization: bearer abcDEF123456ghi", "authorization: bearer [REDACTED:auth_header]"],
    ["mysql -p", "mysql -uroot -pMyS3cret appdb", "mysql -uroot -p[REDACTED:cli_password] appdb"],
    ["curl -u", "curl -u admin:Adm1nPass https://x.local", "curl -u admin:[REDACTED:cli_password] https://x.local"],
    ["--password=", "psql --password=Pg5ecret", "psql --password=[REDACTED:cli_password]"],
    ["docker login -p", "docker login -u me -p Dk3rPass registry.io", "docker login -u me -p [REDACTED:cli_password] registry.io"],
    ["htpasswd -b", "htpasswd -bc .htpasswd admin Htp4ss!", "htpasswd -bc .htpasswd admin [REDACTED:cli_password]"],
    ["--password-stdin", "echo Gh5ecret99 | docker login --password-stdin", "echo [REDACTED:cli_password] | docker login --password-stdin"],
  ])("redacts %s", (_name, input, output) => {
    expect(scrubText(input).value).toBe(output);
  });

  it("redacts encrypted and truncated private keys", () => {
    const encrypted = `-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,ABCDEF0123456789\n\n${S.pemBody}\n-----END RSA PRIVATE KEY-----`;
    expect(scrubText(`key:\n${encrypted}\nend`).value).toBe("key:\n[REDACTED:private_key]\nend");
    const truncated = `-----BEGIN PRIVATE KEY-----\n${S.pemBody}\n${S.pemBody}`;
    expect(scrubText(truncated).value).toBe("[REDACTED:private_key]");
    // Indented keys: a YAML block scalar, an indented code string, a JSON-escaped indented body.
    const yaml = `tls:\n  key: |\n    -----BEGIN PRIVATE KEY-----\n    ${S.pemBody}\n    ${S.pemBody}\n    -----END PRIVATE KEY-----\n  cert: ok`;
    expect(scrubText(yaml).value).toBe("tls:\n  key: |\n    [REDACTED:private_key]\n  cert: ok");
    const code = `KEY = """-----BEGIN RSA PRIVATE KEY-----\n\t${S.pemBody}  \n\t-----END RSA PRIVATE KEY-----"""`;
    expect(scrubText(code).value).toBe('KEY = """[REDACTED:private_key]"""');
    const escaped = `-----BEGIN EC PRIVATE KEY-----\\n  ${S.pemBody}\\n  -----END EC PRIVATE KEY-----`;
    expect(scrubText(escaped).value).toBe("[REDACTED:private_key]");
    // A truncated key stops at the first line that is not part of it.
    expect(scrubText(`-----BEGIN PRIVATE KEY-----\n${S.pemBody}\nnext: value`).value).toBe("[REDACTED:private_key]\nnext: value");
    // A half-written JSONL line (not valid JSON) keeps escaped line breaks.
    const brokenLine = `{"stdout":"-----BEGIN PRIVATE KEY-----\\n${S.pemBody}\\n${S.pemBody}`;
    expect(scrubJsonl(brokenLine).value).toBe(`{"stdout":"[REDACTED:private_key]`);
  });

  it("leaves look-alikes untouched", () => {
    const { value, findings } = scrubText(BENIGN);
    expect(findings).toEqual([]);
    expect(value).toBe(BENIGN);
    expect(scrubJson({ hostCredential: "/home/kdegroise/.config/gh/hosts.yml", credentials: "include" }).findings).toEqual([]);
  });

  it("is idempotent", () => {
    const once = scrubText(PLANTED).value;
    const twice = scrubText(once);
    expect(twice.value).toBe(once);
    expect(twice.findings).toEqual([]);
  });

  it("never reveals a secret in a finding", () => {
    const { findings } = scrubText(PLANTED);
    for (const f of findings) for (const secret of secretValues()) expect(f.preview).not.toContain(secret);
    expect(mask("abcdef")).toBe("a…(6)");
    expect(mask("sk-ant-0123456789")).toBe("sk-a…(17)");
  });

  it("stays linear on long adversarial input", () => {
    const inputs = [
      "a".repeat(200_000),
      "a.".repeat(100_000),
      "password".repeat(25_000),
      "x://".repeat(50_000),
      "-----BEGIN RSA PRIVATE KEY-----\n".repeat(5_000),
      ("DB_PASSWORD=" + "a ".repeat(50)).repeat(1_000),
      "-----BEGIN RSA PRIVATE KEY-----\n" + ("  \n" + "    A".repeat(10)).repeat(10_000),
      "-----BEGIN RSA PRIVATE KEY-----\n" + (" ".repeat(50) + "\n").repeat(4_000),
      "mysql ".repeat(40_000),
      "curl ".repeat(40_000),
      "password='".repeat(20_000),
    ];
    for (const input of inputs) {
      const t = performance.now();
      scrubText(input);
      expect(performance.now() - t).toBeLessThan(1_000);
    }
  });
});

describe("scrubJson", () => {
  it("redacts strings under secret-looking keys and inside nested values", () => {
    const input = { apiKey: S.jsonKey, nested: [{ text: `token ${S.github}` }], count: 3, author: "Kylian", db_password: 12345678, min_password: 8 };
    const { value, findings } = scrubJson(input);
    expect(value).toEqual({
      apiKey: "[REDACTED:assigned_secret]",
      nested: [{ text: "token [REDACTED:github_token]" }],
      count: 3,
      author: "Kylian",
      db_password: "[REDACTED:assigned_secret]",
      min_password: 8,
    });
    expect(findings.map((f) => f.kind).sort()).toEqual(["assigned_secret", "assigned_secret", "github_token"]);
    expect(input.apiKey).toBe(S.jsonKey); // input not mutated
  });
});

describe("scrubJsonSource", () => {
  it("rewrites only the secret tokens and keeps every other byte", () => {
    const source = `{ "id": 12345678901234567890, "ratio": 1.0, "dup": 1, "dup": 2, "password": "${S.envPassword}", "pin_password": 4321,\r\n  "text": "use ${S.github} \\u00e9" }`;
    const r = scrubJsonSource(source)!;
    expect(r.value).toBe(
      `{ "id": 12345678901234567890, "ratio": 1.0, "dup": 1, "dup": 2, "password": "[REDACTED:assigned_secret]", "pin_password": "[REDACTED:assigned_secret]",\r\n  "text": "use [REDACTED:github_token] é" }`,
    );
    expect(() => JSON.parse(r.value)).not.toThrow();
  });

  it("returns null for invalid JSON", () => {
    expect(scrubJsonSource("{not json")).toBeNull();
  });
});

describe("scrubJsonl", () => {
  it("scrubs secrets inside transcript strings, keeping valid JSON and clean lines byte-identical", () => {
    const clean = `{"type":"user","message":{"role":"user","content":"Add the  secret scrubber"}}`;
    const envPaste = JSON.stringify({ type: "user", message: { role: "user", content: `my .env:\nDB_PASSWORD=${S.envPassword}\nPORT=3000` } });
    const toolResult = JSON.stringify({ type: "user", toolUseResult: { stdout: `-----BEGIN RSA PRIVATE KEY-----\n${S.pemBody}\n-----END RSA PRIVATE KEY-----` } });
    const { value, findings } = scrubJsonl([clean, envPaste, toolResult + "\r", "not json " + S.aws, ""].join("\n"));
    const lines = value.split("\n");
    expect(lines[0]).toBe(clean);
    expect(JSON.parse(lines[1]!).message.content).toBe("my .env:\nDB_PASSWORD=[REDACTED:env_secret]\nPORT=3000");
    expect(JSON.parse(lines[2]!).toolUseResult.stdout).toBe("[REDACTED:private_key]");
    expect(lines[2]!.endsWith("\r")).toBe(true);
    expect(lines[3]).toBe("not json [REDACTED:aws_access_key]");
    expect(findings.map((f) => [f.line, f.kind])).toEqual([[2, "env_secret"], [3, "private_key"], [4, "aws_access_key"]]);
    for (const secret of secretValues()) expect(value).not.toContain(secret);
  });
});
