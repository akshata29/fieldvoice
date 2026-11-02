# Evaluation run 20261030-223953-f8f75e

- Dataset: `synth-v1`  - Status: **succeeded**  - Device profile: `dev-box-quiet`
- CPU: Intel(R) Core(TM) Ultra 7 165H (16C/22T), RAM 63.6 GB, Windows 11 10.0.26300
- _Peak RAM is the estimated resident footprint of the models (delta over the process baseline), STT and LLM phases summed._
- _Latency excludes one-off model load (reported as cold start)._
- _Not a field-fleet device: results rank options only and are not representative of the Latitude 7220 (8th-gen U-series CPU, <=16 GB LPDDR3, no NPU)._
- _This CPU has an NPU; auto-selected NPU variants may be used unless variants are pinned._

Gates: p95 <= 5000 ms, id-field accuracy >= 95%, silent-wrong <= 2%

| Rank | Config | Pass | Field acc | ID acc | Silent-wrong | Review | WER(norm) | p50 ms | p95 ms | Tokens in/out | RAM MB | Cold ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| - | `oracle:stt:transcript|foundry:llm:qwen2.5-3b:cpu|enum_grammar` | no | 52.6% | 29.5% | 50.0% | 0.0% | - | 8489 | 11003 | 179/34 | 3049 | 8058 |

## Gate failures

- `oracle:stt:transcript|foundry:llm:qwen2.5-3b:cpu|enum_grammar`: p95 11003 ms > 5000 ms; id accuracy 29.5% < 95%; silent-wrong 50.0% > 2%

_Silent-wrong rate (a confident field that is wrong) is the number that matters, not JSON validity._
