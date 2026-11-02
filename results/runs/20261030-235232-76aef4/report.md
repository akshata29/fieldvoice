# Evaluation run 20261030-235232-76aef4

- Dataset: `synth-v1`  - Status: **succeeded**  - Device profile: `dev-box-quiet`
- CPU: Intel(R) Core(TM) Ultra 7 165H (16C/22T), RAM 63.6 GB, Windows 11 10.0.26300
- _Peak RAM is the estimated resident footprint of the models (delta over the process baseline), STT and LLM phases summed._
- _Latency excludes one-off model load (reported as cold start)._
- _Rescored from run 20261030-221648-364615: transcripts and speech timings are the stored ones; extraction and scoring ran again with the current code._
- _Not a field-fleet device: results rank options only and are not representative of the Latitude 7220 (8th-gen U-series CPU, <=16 GB LPDDR3, no NPU)._
- _This CPU has an NPU; auto-selected NPU variants may be used unless variants are pinned._

Gates: p95 <= 5000 ms, id-field accuracy >= 95%, silent-wrong <= 2%

| Rank | Config | Pass | Field acc | ID acc | Silent-wrong | Review | WER(norm) | p50 ms | p95 ms | Tokens in/out | RAM MB | Cold ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| - | `foundry:stt:whisper-small:cpu|rules:llm:none|rules_only` | no | 77.0% | 84.4% | 0.0% | 2.4% | 6.5% | 3532 | 3791 | -/- | 762 | 3528 |
| - | `foundry:stt:whisper-base:cpu|rules:llm:none|rules_only` | no | 76.1% | 81.8% | 0.0% | 3.8% | 10.5% | 1398 | 1638 | -/- | 408 | 2161 |

## Gate failures

- `foundry:stt:whisper-base:cpu|rules:llm:none|rules_only`: id accuracy 81.8% < 95%
- `foundry:stt:whisper-small:cpu|rules:llm:none|rules_only`: id accuracy 84.4% < 95%

_Silent-wrong rate (a confident field that is wrong) is the number that matters, not JSON validity._
