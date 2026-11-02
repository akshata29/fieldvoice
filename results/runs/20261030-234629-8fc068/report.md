# Evaluation run 20261030-234629-8fc068

- Dataset: `synth-v1`  - Status: **succeeded**  - Device profile: `dev-box-shared`
- CPU: Intel(R) Core(TM) Ultra 7 165H (16C/22T), RAM 63.6 GB, Windows 10 10.0.26300
- _Peak RAM is the estimated resident footprint of the models (delta over the process baseline), STT and LLM phases summed._
- _Latency excludes one-off model load (reported as cold start)._
- _Rescored from run 20261030-190732-9d6a37: transcripts and speech timings are the stored ones; extraction and scoring ran again with the current code._
- _Not a field-fleet device: results rank options only and are not representative of the Latitude 7220 (8th-gen U-series CPU, <=16 GB LPDDR3, no NPU)._
- _This CPU has an NPU; auto-selected NPU variants may be used unless variants are pinned._

Gates: p95 <= 5000 ms, id-field accuracy >= 95%, silent-wrong <= 2%

| Rank | Config | Pass | Field acc | ID acc | Silent-wrong | Review | WER(norm) | p50 ms | p95 ms | Tokens in/out | RAM MB | Cold ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| - | `foundry:stt:whisper-small:cpu|rules:llm:none|rules_only` | no | 91.7% | 93.7% | 0.0% | 1.1% | 6.8% | 8089 | 17533 | -/- | 776 | 2629 |
| - | `foundry:stt:whisper-base:cpu|rules:llm:none|rules_only` | no | 90.2% | 90.3% | 0.3% | 1.8% | 13.6% | 1884 | 2574 | -/- | 430 | 3092 |
| - | `foundry:stt:whisper-tiny:cpu|rules:llm:none|rules_only` | no | 87.2% | 84.4% | 0.4% | 2.8% | 17.8% | 2048 | 3516 | -/- | 284 | 6982 |

## Gate failures

- `foundry:stt:whisper-tiny:cpu|rules:llm:none|rules_only`: id accuracy 84.4% < 95%
- `foundry:stt:whisper-base:cpu|rules:llm:none|rules_only`: id accuracy 90.3% < 95%
- `foundry:stt:whisper-small:cpu|rules:llm:none|rules_only`: p95 17533 ms > 5000 ms; id accuracy 93.7% < 95%

_Silent-wrong rate (a confident field that is wrong) is the number that matters, not JSON validity._
