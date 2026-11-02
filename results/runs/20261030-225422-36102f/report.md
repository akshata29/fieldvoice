# Evaluation run 20261030-225422-36102f

- Dataset: `synth-v1`  - Status: **succeeded**  - Device profile: `dev-box-quiet`
- CPU: Intel(R) Core(TM) Ultra 7 165H (16C/22T), RAM 63.6 GB, Windows 11 10.0.26300
- _Peak RAM is the estimated resident footprint of the models (delta over the process baseline), STT and LLM phases summed._
- _Latency excludes one-off model load (reported as cold start)._
- _Not a field-fleet device: results rank options only and are not representative of the Latitude 7220 (8th-gen U-series CPU, <=16 GB LPDDR3, no NPU)._
- _This CPU has an NPU; auto-selected NPU variants may be used unless variants are pinned._

Gates: p95 <= 5000 ms, id-field accuracy >= 95%, silent-wrong <= 2%

| Rank | Config | Pass | Field acc | ID acc | Silent-wrong | Review | WER(norm) | p50 ms | p95 ms | Tokens in/out | RAM MB | Cold ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| - | `oracle:stt:transcript|foundry:llm:qwen2.5-3b:cpu|free_json` | no | 87.3% | 83.7% | 18.5% | 0.0% | - | 12387 | 13502 | 240/64 | 3038 | 8531 |
| - | `oracle:stt:transcript|foundry:llm:qwen2.5-3b:cpu|schema_constrained` | no | 76.3% | 76.7% | 34.6% | 0.0% | - | 12637 | 13808 | 240/69 | 3082 | 8301 |

## Gate failures

- `oracle:stt:transcript|foundry:llm:qwen2.5-3b:cpu|free_json`: p95 13502 ms > 5000 ms; id accuracy 83.7% < 95%; silent-wrong 18.5% > 2%
- `oracle:stt:transcript|foundry:llm:qwen2.5-3b:cpu|schema_constrained`: p95 13808 ms > 5000 ms; id accuracy 76.7% < 95%; silent-wrong 34.6% > 2%

_Silent-wrong rate (a confident field that is wrong) is the number that matters, not JSON validity._
