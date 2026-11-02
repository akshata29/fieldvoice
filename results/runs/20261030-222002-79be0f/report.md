# Evaluation run 20261030-222002-79be0f

- Dataset: `synth-v1`  - Status: **succeeded**  - Device profile: `dev-box-quiet`
- CPU: Intel(R) Core(TM) Ultra 7 165H (16C/22T), RAM 63.6 GB, Windows 11 10.0.26300
- _Peak RAM is the estimated resident footprint of the models (delta over the process baseline), STT and LLM phases summed._
- _Latency excludes one-off model load (reported as cold start)._
- _Not a field-fleet device: results rank options only and are not representative of the Latitude 7220 (8th-gen U-series CPU, <=16 GB LPDDR3, no NPU)._
- _This CPU has an NPU; auto-selected NPU variants may be used unless variants are pinned._

Gates: p95 <= 5000 ms, id-field accuracy >= 95%, silent-wrong <= 2%

| Rank | Config | Pass | Field acc | ID acc | Silent-wrong | Review | WER(norm) | p50 ms | p95 ms | Tokens in/out | RAM MB | Cold ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| - | `foundry:stt:whisper-base:cpu|foundry:llm:qwen2.5-3b:cpu|hybrid` | no | 90.9% | 81.8% | 0.0% | 22.0% | 10.5% | 7853 | 9363 | 139/21 | 3309 | 11983 |
| - | `foundry:stt:whisper-small:cpu|foundry:llm:qwen2.5-3b:cpu|hybrid` | no | 90.9% | 83.1% | 0.0% | 22.0% | 7.0% | 10774 | 12471 | 143/22 | 3680 | 13554 |
| - | `foundry:stt:whisper-base:cpu|foundry:llm:qwen2.5-1.5b:cpu|hybrid` | no | 85.2% | 81.8% | 0.0% | 21.1% | 10.5% | 4447 | 5154 | 139/20 | 2008 | 9856 |
| - | `foundry:stt:whisper-small:cpu|foundry:llm:qwen2.5-1.5b:cpu|hybrid` | no | 85.2% | 83.1% | 0.0% | 19.6% | 7.0% | 6828 | 7996 | 143/21 | 2364 | 8566 |

## Gate failures

- `foundry:stt:whisper-base:cpu|foundry:llm:qwen2.5-1.5b:cpu|hybrid`: p95 5154 ms > 5000 ms; id accuracy 81.8% < 95%
- `foundry:stt:whisper-base:cpu|foundry:llm:qwen2.5-3b:cpu|hybrid`: p95 9363 ms > 5000 ms; id accuracy 81.8% < 95%
- `foundry:stt:whisper-small:cpu|foundry:llm:qwen2.5-1.5b:cpu|hybrid`: p95 7996 ms > 5000 ms; id accuracy 83.1% < 95%
- `foundry:stt:whisper-small:cpu|foundry:llm:qwen2.5-3b:cpu|hybrid`: p95 12471 ms > 5000 ms; id accuracy 83.1% < 95%

_Silent-wrong rate (a confident field that is wrong) is the number that matters, not JSON validity._
