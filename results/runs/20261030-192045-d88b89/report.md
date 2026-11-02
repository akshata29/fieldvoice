# Evaluation run 20261030-192045-d88b89

- Dataset: `synth-v1`  - Status: **succeeded**  - Device profile: `dev-box-shared`
- CPU: Intel(R) Core(TM) Ultra 7 165H (16C/22T), RAM 63.6 GB, Windows 10 10.0.26300
- _Peak RAM is the estimated resident footprint of the models (delta over the process baseline), STT and LLM phases summed._
- _Latency excludes one-off model load (reported as cold start)._
- _Not a field-fleet device: results rank options only and are not representative of the Latitude 7220 (8th-gen U-series CPU, <=16 GB LPDDR3, no NPU)._
- _This CPU has an NPU; auto-selected NPU variants may be used unless variants are pinned._

Gates: p95 <= 5000 ms, id-field accuracy >= 95%, silent-wrong <= 2%

| Rank | Config | Pass | Field acc | ID acc | Silent-wrong | Review | WER(norm) | p50 ms | p95 ms | Tokens in/out | RAM MB | Cold ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `oracle:stt:transcript|rules:llm:none|rules_only` | yes | 81.7% | 100.0% | 0.0% | 3.9% | - | 1 | 1 | -/- | 1 | - |
| - | `oracle:stt:transcript|foundry:llm:qwen2.5-0.5b:cpu|hybrid` | no | 70.6% | 100.0% | 0.0% | 20.5% | - | 5183 | 7488 | 126/15 | 771 | 11496 |
| - | `oracle:stt:transcript|foundry:llm:qwen2.5-0.5b:cpu|hybrid_always` | no | 70.1% | 100.0% | 0.0% | 21.1% | - | 3762 | 6907 | 123/14 | 718 | 10042 |
| - | `oracle:stt:transcript|foundry:llm:qwen2.5-0.5b:cpu|enum_grammar` | no | 46.3% | 42.6% | 65.1% | 0.0% | - | 6030 | 19437 | 179/36 | 780 | 15612 |

## Gate failures

- `oracle:stt:transcript|foundry:llm:qwen2.5-0.5b:cpu|hybrid`: p95 7488 ms > 5000 ms
- `oracle:stt:transcript|foundry:llm:qwen2.5-0.5b:cpu|hybrid_always`: p95 6907 ms > 5000 ms
- `oracle:stt:transcript|foundry:llm:qwen2.5-0.5b:cpu|enum_grammar`: p95 19437 ms > 5000 ms; id accuracy 42.6% < 95%; silent-wrong 65.1% > 2%

_Silent-wrong rate (a confident field that is wrong) is the number that matters, not JSON validity._
