# Evaluation run 20261030-190732-9d6a37

- Dataset: `synth-v1`  - Status: **succeeded**  - Device profile: `dev-box-shared`
- CPU: Intel(R) Core(TM) Ultra 7 165H (16C/22T), RAM 63.6 GB, Windows 10 10.0.26300
- _Peak RAM is the estimated resident footprint of the models (delta over the process baseline), STT and LLM phases summed._
- _Latency excludes one-off model load (reported as cold start)._
- _Not a field-fleet device: results rank options only and are not representative of the Latitude 7220 (8th-gen U-series CPU, <=16 GB LPDDR3, no NPU)._
- _This CPU has an NPU; auto-selected NPU variants may be used unless variants are pinned._

Gates: p95 <= 5000 ms, id-field accuracy >= 95%, silent-wrong <= 2%

| Rank | Config | Pass | Field acc | ID acc | Silent-wrong | Review | WER(norm) | p50 ms | p95 ms | Tokens in/out | RAM MB | Cold ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| - | `foundry:stt:whisper-small:cpu|rules:llm:none|rules_only` | no | 91.3% | 92.6% | 0.0% | 1.4% | 7.6% | 8090 | 17534 | -/- | 776 | 2629 |
| - | `foundry:stt:whisper-base:cpu|rules:llm:none|rules_only` | no | 90.0% | 90.0% | 0.3% | 1.8% | 13.8% | 1890 | 2575 | -/- | 429 | 3092 |
| - | `foundry:stt:whisper-tiny:cpu|rules:llm:none|rules_only` | no | 86.4% | 82.2% | 0.4% | 3.5% | 19.6% | 2048 | 3517 | -/- | 284 | 6982 |

## Gate failures

- `foundry:stt:whisper-tiny:cpu|rules:llm:none|rules_only`: id accuracy 82.2% < 95%
- `foundry:stt:whisper-base:cpu|rules:llm:none|rules_only`: id accuracy 90.0% < 95%
- `foundry:stt:whisper-small:cpu|rules:llm:none|rules_only`: p95 17534 ms > 5000 ms; id accuracy 92.6% < 95%

_Silent-wrong rate (a confident field that is wrong) is the number that matters, not JSON validity._
