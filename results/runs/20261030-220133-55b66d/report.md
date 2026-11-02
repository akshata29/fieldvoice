# Evaluation run 20261030-220133-55b66d

- Dataset: `synth-v1`  - Status: **succeeded**  - Device profile: `dev-box-quiet`
- CPU: Intel(R) Core(TM) Ultra 7 165H (16C/22T), RAM 63.6 GB, Windows 11 10.0.26300
- _Peak RAM is the estimated resident footprint of the models (delta over the process baseline), STT and LLM phases summed._
- _Latency excludes one-off model load (reported as cold start)._
- _Not a field-fleet device: results rank options only and are not representative of the Latitude 7220 (8th-gen U-series CPU, <=16 GB LPDDR3, no NPU)._
- _This CPU has an NPU; auto-selected NPU variants may be used unless variants are pinned._

Gates: p95 <= 5000 ms, id-field accuracy >= 95%, silent-wrong <= 2%

| Rank | Config | Pass | Field acc | ID acc | Silent-wrong | Review | WER(norm) | p50 ms | p95 ms | Tokens in/out | RAM MB | Cold ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| - | `oracle:stt:transcript|foundry:llm:ministral-3-3b-instruct-2512:cpu|hybrid` | no | 98.3% | 100.0% | 0.0% | 21.3% | - | 6393 | 9320 | 131/22 | 4431 | 17943 |

## Gate failures

- `oracle:stt:transcript|foundry:llm:ministral-3-3b-instruct-2512:cpu|hybrid`: p95 9320 ms > 5000 ms

_Silent-wrong rate (a confident field that is wrong) is the number that matters, not JSON validity._
