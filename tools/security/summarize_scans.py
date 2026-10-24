#!/usr/bin/env python3
"""Fold the CI security scanners' raw outputs into one summary document (security-controls, enterprise program).

The same file lives in every repository (engine, admin UI, EA, cme-feed); keep the copies identical.

    python3 tools/security/summarize_scans.py --repo lascodia-trading-engine --commit "$GITHUB_SHA" \
        --gitleaks out/gitleaks.json --semgrep out/semgrep.json --trivy-image out/trivy-image.json \
        --dotnet out/dotnet-vulnerable.json --npm out/npm-audit.json --pip out/pip-audit.json \
        --sbom out/sbom.cdx.json --out out/security-summary.json

Every input is optional; a missing or unreadable file is reported as "skipped", never as a pass. The output
(schema "lascodia.security-scan-summary/v1") is what the engine's evidence bundle reads
(Security:Evidence:ScanSummaryDirectory) and what the workflow writes into its step summary.

Exit status: 0 always unless --fail-on is given; with --fail-on high (or critical) it exits 1 when any scanner reports
an un-triaged finding at or above that severity. Triage lives in the scanners' own ignore files (.gitleaksignore,
.trivyignore, semgrep baseline / nosemgrep), reviewed in docs/security/scan-triage.md — not here.
"""
import argparse
import datetime as dt
import json
import pathlib
import sys

SEVERITIES = ["critical", "high", "medium", "low", "unknown"]
SCHEMA = "lascodia.security-scan-summary/v1"


def _load(path):
    if not path:
        return None
    p = pathlib.Path(path)
    if not p.is_file() or p.stat().st_size == 0:
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _counts():
    return {s: 0 for s in SEVERITIES}


def _norm(sev):
    s = (sev or "unknown").strip().lower()
    return {"error": "high", "warning": "medium", "info": "low", "moderate": "medium", "note": "low"}.get(s, s if s in SEVERITIES else "unknown")


def _entry(name, data, fn, detail_when_skipped="input not produced"):
    if data is None:
        return {"name": name, "status": "skipped", "counts": _counts(), "total": 0, "detail": detail_when_skipped}
    counts, detail = fn(data)
    total = sum(counts.values())
    return {"name": name, "status": "findings" if total else "clean", "counts": counts, "total": total, "detail": detail}


def gitleaks(data):
    c = _counts()
    c["high"] = len(data) if isinstance(data, list) else 0
    rules = sorted({f.get("RuleID", "?") for f in data}) if isinstance(data, list) else []
    return c, ("rules: " + ", ".join(rules)) if rules else "no un-ignored secrets"


def semgrep(data):
    c = _counts()
    results = data.get("results", []) if isinstance(data, dict) else []
    for r in results:
        c[_norm(r.get("extra", {}).get("severity"))] += 1
    return c, f"{len(results)} result(s), {len(data.get('errors', []))} parse error(s)" if isinstance(data, dict) else ""


def trivy(data):
    c = _counts()
    n_targets = 0
    for r in (data.get("Results") or []) if isinstance(data, dict) else []:
        n_targets += 1
        for v in r.get("Vulnerabilities") or []:
            c[_norm(v.get("Severity"))] += 1
        for m in r.get("Misconfigurations") or []:
            c[_norm(m.get("Severity"))] += 1
    name = data.get("ArtifactName", "") if isinstance(data, dict) else ""
    return c, f"{name} ({n_targets} target(s))"


def dotnet(data):
    # `dotnet list package --vulnerable --include-transitive --format json`
    c = _counts()
    seen = set()
    for proj in data.get("projects", []) if isinstance(data, dict) else []:
        for fw in proj.get("frameworks", []) or []:
            for pkg in (fw.get("topLevelPackages") or []) + (fw.get("transitivePackages") or []):
                for v in pkg.get("vulnerabilities", []) or []:
                    key = (pkg.get("id"), pkg.get("resolvedVersion"), v.get("advisoryurl"))
                    if key in seen:
                        continue
                    seen.add(key)
                    c[_norm(v.get("severity"))] += 1
    return c, f"{len(data.get('projects', []))} project(s)" if isinstance(data, dict) else ""


def npm(data):
    c = _counts()
    meta = (data.get("metadata") or {}).get("vulnerabilities") or {}
    for k, v in meta.items():
        if k in ("total", "info"):
            continue
        c[_norm(k)] += int(v or 0)
    return c, "npm audit (as configured by the workflow step)"


def pip(data):
    c = _counts()
    deps = data.get("dependencies", []) if isinstance(data, dict) else (data if isinstance(data, list) else [])
    n = 0
    for d in deps:
        for _ in d.get("vulns", []) or []:
            c["high"] += 1  # pip-audit carries no severity: counted as high (conservative) until triaged
            n += 1
    return c, f"{len(deps)} package(s) audited, {n} advisory(ies)"


def sbom_info(data):
    if not isinstance(data, dict):
        return None
    comps = data.get("components") or []
    return {"format": data.get("bomFormat"), "specVersion": data.get("specVersion"), "components": len(comps)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--commit", default="")
    ap.add_argument("--ref", default="")
    ap.add_argument("--gitleaks")
    ap.add_argument("--semgrep")
    ap.add_argument("--trivy-image")
    ap.add_argument("--trivy-fs")
    ap.add_argument("--dotnet")
    ap.add_argument("--npm")
    ap.add_argument("--npm-dev")
    ap.add_argument("--pip")
    ap.add_argument("--sbom", action="append", default=[])
    ap.add_argument("--out", required=True)
    ap.add_argument("--markdown", help="also append a Markdown table here (e.g. $GITHUB_STEP_SUMMARY)")
    ap.add_argument("--fail-on", choices=["critical", "high"], default=None)
    a = ap.parse_args()

    scanners = [
        _entry("gitleaks (secrets)", _load(a.gitleaks), gitleaks) if a.gitleaks is not None else None,
        _entry("semgrep (SAST)", _load(a.semgrep), semgrep) if a.semgrep is not None else None,
        _entry("trivy (image)", _load(a.trivy_image), trivy) if a.trivy_image is not None else None,
        _entry("trivy (filesystem)", _load(a.trivy_fs), trivy) if a.trivy_fs is not None else None,
        _entry("dotnet list package --vulnerable", _load(a.dotnet), dotnet) if a.dotnet is not None else None,
        _entry("npm audit (production)", _load(a.npm), npm) if a.npm is not None else None,
        _entry("npm audit (dev tooling, report only)", _load(a.npm_dev), npm) if a.npm_dev is not None else None,
        _entry("pip-audit", _load(a.pip), pip) if a.pip is not None else None,
    ]
    scanners = [s for s in scanners if s is not None]
    sboms = [x for x in (sbom_info(_load(p)) for p in a.sbom) if x]

    doc = {
        "schema": SCHEMA,
        "repo": a.repo,
        "commit": a.commit,
        "ref": a.ref,
        "generatedAtUtc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "scanners": scanners,
        "sbom": sboms,
        "note": "Counts are findings left after the repository's reviewed ignore files; see docs/security/scan-triage.md.",
    }
    out = pathlib.Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")

    if a.markdown:
        lines = [f"## Security scans — {a.repo}", "", "| Scanner | Status | Critical | High | Medium | Low | Unknown | Detail |",
                 "|---|---|---|---|---|---|---|---|"]
        for s in scanners:
            c = s["counts"]
            lines.append(f"| {s['name']} | {s['status']} | {c['critical']} | {c['high']} | {c['medium']} | {c['low']} | {c['unknown']} | {s['detail']} |")
        for b in sboms:
            lines.append(f"\nSBOM: {b['format']} {b['specVersion']}, {b['components']} component(s)")
        with open(a.markdown, "a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")

    if a.fail_on:
        limit = SEVERITIES[: SEVERITIES.index(a.fail_on) + 1]
        gating = [s for s in scanners if "report only" not in s["name"]]
        bad = [s["name"] for s in gating if any(s["counts"][k] for k in limit)]
        if bad:
            print(f"un-triaged {a.fail_on}+ findings: {', '.join(bad)}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
