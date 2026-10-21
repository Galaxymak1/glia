import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { type Finding, scrubJsonSource, scrubJsonl, scrubText } from "./scrub.js";

/** Where Claude Code keeps transcripts and auto memory. */
export function defaultTranscriptsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

const TEXT_EXTS = new Set([".jsonl", ".json", ".md", ".txt"]);
const isScannable = (path: string) => TEXT_EXTS.has(extname(path)) || basename(path).startsWith(".env");

export interface FileFindings {
  path: string;
  findings: Finding[];
}

export interface ScanReport {
  filesScanned: number;
  filesSkipped: number;
  bytesScanned: number;
  files: FileFindings[]; // only files with findings
}

function* walk(path: string): Generator<string> {
  const st = statSync(path);
  if (st.isFile()) {
    yield path;
    return;
  }
  if (!st.isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    yield* walk(join(path, entry.name));
  }
}

export function scrubFileContent(path: string, content: string): Finding[] {
  if (path.endsWith(".jsonl")) return scrubJsonl(content).findings;
  if (path.endsWith(".json")) {
    const r = scrubJsonSource(content);
    if (r) return r.findings; // not valid JSON: fall through to text
  }
  return scrubText(content).findings;
}

/** Reports what scrubbing would remove under `paths`. Reads only; writes nothing. */
export function scanPaths(paths: string[]): ScanReport {
  const report: ScanReport = { filesScanned: 0, filesSkipped: 0, bytesScanned: 0, files: [] };
  for (const root of paths) {
    for (const file of walk(root)) {
      if (!isScannable(file)) {
        report.filesSkipped++;
        continue;
      }
      const content = readFileSync(file, "utf8");
      report.filesScanned++;
      report.bytesScanned += Buffer.byteLength(content);
      const findings = scrubFileContent(file, content);
      if (findings.length) report.files.push({ path: file, findings });
    }
  }
  return report;
}

export function formatReport(report: ScanReport, show: boolean): string {
  const mb = (report.bytesScanned / 1e6).toFixed(1);
  const out = [`Scanned ${report.filesScanned} files (${mb} MB); skipped ${report.filesSkipped} non-text files.`];
  const all = report.files.flatMap((f) => f.findings);
  if (!all.length) {
    out.push("Nothing to redact.");
    return out.join("\n");
  }
  out.push(`Would redact ${all.length} secrets in ${report.files.length} files:`);
  const byKind = new Map<string, number>();
  for (const f of all) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
  const width = Math.max(...[...byKind.keys()].map((k) => k.length));
  for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) out.push(`  ${kind.padEnd(width)}  ${n}`);
  if (show) {
    out.push("", "Findings (masked):");
    for (const file of report.files) {
      for (const f of file.findings) out.push(`  ${file.path}${f.line ? `:${f.line}` : ""}  ${f.kind}  ${f.preview}`);
    }
  }
  return out.join("\n");
}
