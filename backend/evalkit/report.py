"""Decision gates, Pareto frontier and Markdown report for an evaluation run."""
from __future__ import annotations

from backend.schemas.eval import ConfigMetrics, DecisionGates, DecisionReport, DecisionRow, ParetoPoint, RunSummary

# Machine-readable gate codes (the UI renders its own explanations from them; the Markdown report uses explain_gate()).
GATE_P95 = "max_p95_ms"
GATE_ID_ACCURACY = "min_id_field_accuracy"
GATE_SILENT_WRONG = "max_silent_wrong"
GATE_RAM = "max_peak_rss_mb"
GATE_FIELD_ACCURACY = "min_field_accuracy"
GATE_NO_CASES = "no_successful_cases"


def failed_gate_codes(m: ConfigMetrics, g: DecisionGates) -> list[str]:
    if m.n_cases == 0 or m.n_errors >= m.n_cases:
        return [GATE_NO_CASES]
    failed: list[str] = []
    p95 = m.latency_total.p95
    if p95 is None or p95 > g.max_p95_ms:  # a missing measurement cannot pass a gate that needs it
        failed.append(GATE_P95)
    if m.id_field_accuracy is not None and m.id_field_accuracy < g.min_id_field_accuracy:
        failed.append(GATE_ID_ACCURACY)
    if m.silent_wrong_rate > g.max_silent_wrong:
        failed.append(GATE_SILENT_WRONG)
    if g.max_peak_rss_mb is not None and (m.peak_rss_mb is None or m.peak_rss_mb > g.max_peak_rss_mb):
        failed.append(GATE_RAM)
    if m.field_accuracy < g.min_field_accuracy:
        failed.append(GATE_FIELD_ACCURACY)
    return failed


def explain_gate(code: str, m: ConfigMetrics, g: DecisionGates) -> str:
    p95 = m.latency_total.p95
    if code == GATE_NO_CASES:
        return "no case ran successfully (engine unavailable or failed to load)"
    if code == GATE_P95:
        return "p95 latency not measured" if p95 is None else f"p95 {p95:.0f} ms > {g.max_p95_ms:.0f} ms"
    if code == GATE_ID_ACCURACY:
        return f"id accuracy {m.id_field_accuracy:.1%} < {g.min_id_field_accuracy:.0%}"
    if code == GATE_SILENT_WRONG:
        return f"silent-wrong {m.silent_wrong_rate:.1%} > {g.max_silent_wrong:.0%}"
    if code == GATE_RAM:
        return "peak RAM not measured" if m.peak_rss_mb is None else f"RAM {m.peak_rss_mb:.0f} MB > {g.max_peak_rss_mb:.0f} MB"
    if code == GATE_FIELD_ACCURACY:
        return f"field accuracy {m.field_accuracy:.1%} < {g.min_field_accuracy:.0%}"
    return code


def _score(m: ConfigMetrics) -> float:
    """Ranking among configs that pass the gates: accuracy first, silent errors punished, one point per second of p95."""
    p95_s = (m.latency_total.p95 or 0.0) / 1000.0
    return 100.0 * m.field_accuracy - 200.0 * m.silent_wrong_rate - 5.0 * m.review_rate - p95_s


def pareto_points(configs: list[ConfigMetrics]) -> list[ParetoPoint]:
    pts = [
        ParetoPoint(config_key=m.config_key, p95_ms=m.latency_total.p95, field_accuracy=m.field_accuracy,
                    silent_wrong_rate=m.silent_wrong_rate)
        for m in configs if m.n_cases > 0 and m.n_errors < m.n_cases
    ]
    for p in pts:
        p.pareto_optimal = not any(
            q is not p and q.p95_ms is not None and p.p95_ms is not None
            and q.p95_ms <= p.p95_ms and q.field_accuracy >= p.field_accuracy
            and (q.p95_ms < p.p95_ms or q.field_accuracy > p.field_accuracy)
            for q in pts
        )
    return pts


def decide(summary: RunSummary, gates: DecisionGates | None = None) -> DecisionReport:
    gates = gates or DecisionGates()
    rows: list[DecisionRow] = []
    for m in summary.configs:
        failed = failed_gate_codes(m, gates)
        rows.append(DecisionRow(config_key=m.config_key, passes=not failed, failed_gates=failed, score=_score(m)))
    ranked = sorted((r for r in rows if r.passes), key=lambda r: -r.score)
    for i, r in enumerate(ranked, start=1):
        r.rank = i
    return DecisionReport(run_id=summary.run_id, gates=gates, rows=rows, pareto=pareto_points(summary.configs))


def _fmt(v: float | None, pct: bool = False, digits: int = 0) -> str:
    if v is None:
        return "-"
    return f"{v:.1%}" if pct else f"{v:.{digits}f}"


def markdown_report(summary: RunSummary, report: DecisionReport) -> str:
    hw = summary.hardware
    lines = [
        f"# Evaluation run {summary.run_id}",
        "",
        f"- Dataset: `{summary.dataset_id}`  - Status: **{summary.status}**  - Device profile: `{hw.device_profile}`",
        f"- CPU: {hw.cpu_name} ({hw.physical_cores}C/{hw.logical_cores}T), RAM {hw.ram_gb} GB, {hw.os} {hw.os_build}",
    ]
    for n in summary.notes:
        lines.append(f"- _{n}_")
    g = report.gates
    lines += [
        "",
        f"Gates: p95 <= {g.max_p95_ms:.0f} ms, id-field accuracy >= {g.min_id_field_accuracy:.0%}, "
        f"silent-wrong <= {g.max_silent_wrong:.0%}" + (f", RAM <= {g.max_peak_rss_mb:.0f} MB" if g.max_peak_rss_mb else ""),
        "",
        "| Rank | Config | Pass | Field acc | ID acc | Silent-wrong | Review | WER(norm) | p50 ms | p95 ms | Tokens in/out | RAM MB | Cold ms |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    by_key = {r.config_key: r for r in report.rows}
    ordered = sorted(summary.configs, key=lambda m: (by_key[m.config_key].rank or 999, -m.field_accuracy))
    for m in ordered:
        r = by_key[m.config_key]
        toks = f"{_fmt(m.llm_prompt_tokens_mean)}/{_fmt(m.llm_output_tokens_mean)}"
        lines.append(
            f"| {r.rank or '-'} | `{m.config_key}` | {'yes' if r.passes else 'no'} | {_fmt(m.field_accuracy, True)} | "
            f"{_fmt(m.id_field_accuracy, True)} | {_fmt(m.silent_wrong_rate, True)} | {_fmt(m.review_rate, True)} | "
            f"{_fmt(m.wer_normalized, True)} | {_fmt(m.latency_total.p50)} | {_fmt(m.latency_total.p95)} | {toks} | "
            f"{_fmt(m.peak_rss_mb)} | {_fmt(m.cold_start_ms)} |")
    fails = [r for r in report.rows if not r.passes]
    if fails:
        by_metrics = {m.config_key: m for m in summary.configs}
        lines += ["", "## Gate failures", ""]
        for r in fails:
            lines.append(f"- `{r.config_key}`: " + "; ".join(explain_gate(c, by_metrics[r.config_key], g) for c in r.failed_gates))
    lines += ["", "_Silent-wrong rate (a confident field that is wrong) is the number that matters, not JSON validity._"]
    return "\n".join(lines) + "\n"
