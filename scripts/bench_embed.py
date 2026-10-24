#!/usr/bin/env python3
"""BGE-M3 cost on this machine (#15): query latency, throughput, runner memory, free RAM.

Self-contained (standard library only) and uses synthetic text, so nothing from the history has
to be copied to the machine being measured. Same model and request options as `brain index`.

    ollama pull hf.co/gpustack/bge-m3-GGUF:Q8_0
    python3 scripts/bench_embed.py [--url http://localhost:11434] [--model hf.co/gpustack/bge-m3-GGUF:Q8_0]
"""
import argparse, json, os, random, statistics, subprocess, time, urllib.request

WORDS = ("the brain index stores every turn of every conversation and finds it again by keyword or "
         "by meaning la base de données garde chaque échange et le retrouve par mot ou par sens "
         "docker image pipeline release tax account recipe travel kubernetes sqlite vector").split()


def text(chars, rng):
    out = []
    while sum(len(w) + 1 for w in out) < chars:
        out.append(rng.choice(WORDS))
    return " ".join(out)[:chars]


def embed(url, model, texts):
    body = json.dumps({"model": model, "input": texts, "truncate": False,
                       "options": {"num_ctx": 8192, "num_batch": 8192}}).encode()
    req = urllib.request.Request(f"{url.rstrip('/')}/api/embed", data=body, headers={"Content-Type": "application/json"})
    t = time.perf_counter()
    with urllib.request.urlopen(req, timeout=900) as r:
        res = json.load(r)
    return time.perf_counter() - t, res


def meminfo():
    info = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, v = line.split(":", 1)
            info[k] = int(v.split()[0]) // 1024  # MB
    return info


def runner_rss_mb():
    """RSS of Ollama's model runner processes, in MB (0 if none found)."""
    try:
        out = subprocess.run(["ps", "-eo", "rss,args"], capture_output=True, text=True).stdout
    except OSError:
        return 0
    return sum(int(l.split()[0]) for l in out.splitlines()[1:] if "runner" in l or "llama-server" in l) // 1024


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", default="http://localhost:11434")
    p.add_argument("--model", default="hf.co/gpustack/bge-m3-GGUF:Q8_0")
    a = p.parse_args()
    rng = random.Random(7)

    before = meminfo()
    dt, res = embed(a.url, a.model, ["warm up"])
    print(f"model: {a.model}  dims: {len(res['embeddings'][0])}  cold start: {dt:.1f} s")

    times = sorted(embed(a.url, a.model, [text(rng.randint(30, 120), rng)])[0] * 1000 for _ in range(100))
    print(f"100 single queries (warm): p50 {times[50]:.0f} ms, p95 {times[95]:.0f} ms, max {times[-1]:.0f} ms")

    for chars, n in [(400, 32), (1400, 16), (5600, 4)]:
        dt, res = embed(a.url, a.model, [text(chars, rng) for _ in range(n)])
        toks = res.get("prompt_eval_count") or 0
        print(f"throughput, {n} x {chars} chars: {toks / dt:.0f} tokens/s ({n / dt:.1f} texts/s, {toks} tokens)")

    after = meminfo()
    print(f"runner RSS: {runner_rss_mb()} MB")
    print(f"RAM: total {after['MemTotal']} MB, available {after['MemAvailable']} MB with the model loaded "
          f"({before['MemAvailable']} MB before the warm-up)")
    print("SPEC rule: under 4 GB of free RAM, use the Mistral Embed fallback.")


if __name__ == "__main__":
    main()
