# Evaluation run 20261030-234636-93ea73

- Dataset: `synth-v1`  - Status: **succeeded**  - Device profile: `dev-box-quiet`
- CPU: Intel(R) Core(TM) Ultra 7 165H (16C/22T), RAM 63.6 GB, Windows 11 10.0.26300
- _Peak RAM is the estimated resident footprint of the models (delta over the process baseline), STT and LLM phases summed._
- _Latency excludes one-off model load (reported as cold start)._
- _Rescored from run 20261030-231428-4524dd: transcripts and speech timings are the stored ones; extraction and scoring ran again with the current code._
- _Not a field-fleet device: results rank options only and are not representative of the Latitude 7220 (8th-gen U-series CPU, <=16 GB LPDDR3, no NPU)._
- _This CPU has an NPU; auto-selected NPU variants may be used unless variants are pinned._

Gates: p95 <= 5000 ms, id-field accuracy >= 95%, silent-wrong <= 2%

| Rank | Config | Pass | Field acc | ID acc | Silent-wrong | Review | WER(norm) | p50 ms | p95 ms | Tokens in/out | RAM MB | Cold ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| - | `foundry:stt:whisper-medium:cpu|rules:llm:none|rules_only` | no | 92.0% | 94.1% | 0.3% | 1.3% | 6.7% | 9386 | 10082 | -/- | 1548 | 4870 |
| - | `foundry:stt:nemotron-speech-streaming-en-0.6b:cpu|rules:llm:none|rules_only` | no | 89.9% | 89.2% | 0.7% | 2.9% | 7.1% | 3413 | 5322 | -/- | 948 | 2092 |

## Gate failures

- `foundry:stt:nemotron-speech-streaming-en-0.6b:cpu|rules:llm:none|rules_only`: p95 5322 ms > 5000 ms; id accuracy 89.2% < 95%
- `foundry:stt:whisper-medium:cpu|rules:llm:none|rules_only`: p95 10082 ms > 5000 ms; id accuracy 94.1% < 95%

_Silent-wrong rate (a confident field that is wrong) is the number that matters, not JSON validity._
