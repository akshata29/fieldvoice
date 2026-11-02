# Evaluation run 20261030-200145-37cfb1

- Dataset: `demo-script`  - Status: **succeeded**  - Device profile: `dev-box`
- CPU: Intel(R) Core(TM) Ultra 7 165H (16C/22T), RAM 63.6 GB, Windows 10 10.0.26300
- _Peak RAM is the estimated resident footprint of the models (delta over the process baseline), STT and LLM phases summed._
- _Latency excludes one-off model load (reported as cold start)._
- _Not a field-fleet device: results rank options only and are not representative of the Latitude 7220 (8th-gen U-series CPU, <=16 GB LPDDR3, no NPU)._
- _This CPU has an NPU; auto-selected NPU variants may be used unless variants are pinned._

Gates: p95 <= 5000 ms, id-field accuracy >= 95%, silent-wrong <= 2%

| Rank | Config | Pass | Field acc | ID acc | Silent-wrong | Review | WER(norm) | p50 ms | p95 ms | Tokens in/out | RAM MB | Cold ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `oracle:stt:transcript|rules:llm:none|rules_only` | yes | 94.5% | 100.0% | 0.0% | 0.0% | - | 1 | 2 | -/- | 0 | - |

_Silent-wrong rate (a confident field that is wrong) is the number that matters, not JSON validity._
