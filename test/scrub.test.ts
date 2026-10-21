import { describe, expect, it } from "vitest";
import { type SecretKind, scrubJson, scrubJsonl, scrubText } from "../src/scrub.js";

// Planted secrets, assembled at runtime so no real-looking token sits in the repo.
const S = {
  anthropic: "sk-ant-" + "api03-" + "A1b2".repeat(20),
  openai: "sk-" + "proj-" + "Zx9".repeat(16),
  github: "gh" + "p_" + "Q".repeat(36),
  githubPat: "github" + "_pat_" + "11ABC" + "d".repeat(30),
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
PORT=3000
NODE_ENV=production
PWD=/home/kdegroise/dev
API_KEY=\${API_KEY}
SECRET_TOKEN=<your token here>
The tool result cap is 25k tokens; set max_tokens accordingly.
commit 5412132d8500a7029ae7645369134499c4764741, session 4e72e044-0bd2-40ea-afbf-fa36accc5e46
tokenize = 'unicode61 remove_diacritics 2'
author: "Kylian"
{"permissionMode":"bypassPermissions","input_tokens":1234}
Send a Bearer token in the Authorization header.
password: "[REDACTED:assigned_secret]"
{"hostCredential":"/home/kdegroise/.config/gh/hosts.yml"}
credentials = "1.5.0"
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
      "private_key", "anthropic_key", "openai_key", "github_token", "aws_access_key", "slack_token", "stripe_key",
      "google_api_key", "jwt", "bearer_token", "url_credentials", "env_secret", "assigned_secret",
    ];
    for (const k of expected) expect(kinds).toContain(k);
  });

  it("keeps the text around a secret", () => {
    expect(scrubText(`DB_PASSWORD=${S.envPassword} # local`).value).toBe("DB_PASSWORD=[REDACTED:env_secret] # local");
    expect(scrubText(`postgres://brain:${S.urlPassword}@db:5432`).value).toBe("postgres://brain:[REDACTED:url_credentials]@db:5432");
  });

  it("leaves look-alikes untouched", () => {
    const { value, findings } = scrubText(BENIGN);
    expect(scrubJson({ hostCredential: "/home/kdegroise/.config/gh/hosts.yml" }).findings).toEqual([]);
    expect(findings).toEqual([]);
    expect(value).toBe(BENIGN);
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
  });
});

describe("scrubJson", () => {
  it("redacts strings under secret-looking keys and inside nested values", () => {
    const input = { apiKey: S.jsonKey, nested: [{ text: `token ${S.github}` }], count: 3, author: "Kylian" };
    const { value, findings } = scrubJson(input);
    expect(value).toEqual({
      apiKey: "[REDACTED:assigned_secret]",
      nested: [{ text: "token [REDACTED:github_token]" }],
      count: 3,
      author: "Kylian",
    });
    expect(findings.map((f) => f.kind).sort()).toEqual(["assigned_secret", "github_token"]);
    expect(input.apiKey).toBe(S.jsonKey); // input not mutated
  });
});

describe("scrubJsonl", () => {
  it("scrubs secrets inside transcript strings, keeping valid JSON and clean lines byte-identical", () => {
    const clean = `{"type":"user","message":{"role":"user","content":"Add the  secret scrubber"}}`;
    const envPaste = JSON.stringify({ type: "user", message: { role: "user", content: `my .env:\nDB_PASSWORD=${S.envPassword}\nPORT=3000` } });
    const toolResult = JSON.stringify({ type: "user", toolUseResult: { stdout: `-----BEGIN RSA PRIVATE KEY-----\n${S.pemBody}\n-----END RSA PRIVATE KEY-----` } });
    const { value, findings } = scrubJsonl([clean, envPaste, toolResult, "not json " + S.aws, ""].join("\n"));
    const lines = value.split("\n");
    expect(lines[0]).toBe(clean);
    expect(JSON.parse(lines[1]!).message.content).toBe("my .env:\nDB_PASSWORD=[REDACTED:env_secret]\nPORT=3000");
    expect(JSON.parse(lines[2]!).toolUseResult.stdout).toBe("[REDACTED:private_key]");
    expect(lines[3]).toBe("not json [REDACTED:aws_access_key]");
    expect(findings.map((f) => [f.line, f.kind])).toEqual([[2, "env_secret"], [3, "private_key"], [4, "aws_access_key"]]);
    for (const secret of secretValues()) expect(value).not.toContain(secret);
  });
});
