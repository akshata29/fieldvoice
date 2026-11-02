# Device probe - profile `dev-box-quiet`

- Intel(R) Core(TM) Ultra 7 165H (16C/22T), 63.6 GB RAM, Windows 11
- _Not a field-fleet device: results rank options only and are not representative of the Latitude 7220 (8th-gen U-series CPU, <=16 GB LPDDR3, no NPU)._
- _This CPU has an NPU; auto-selected NPU variants may be used unless variants are pinned._

## Language model `foundry:llm:qwen2.5-3b:cpu`

Cold start 10880 ms, about 2666 MB resident.
Fixed cost per call (session setup): 0 ms; prompt: 34.1 ms per token; generation: 67.2 ms per token (15 tokens/s).

| Call | p50 ms | best ms | worst ms | Tokens in/out |
|---|---|---|---|---|
| 1 field, grammar | 5141 | 4575 | 6025 | 134/6 |
| 1 field, json schema | 5036 | 4996 | 5108 | 134/9 |
| 1 field, unconstrained | 5065 | 4913 | 5816 | 134/8 |
| 3 fields, grammar | 6857 | 6546 | 7092 | 168/18 |
| 3 fields, json schema | 7352 | 7168 | 7733 | 168/25 |
| 3 fields, unconstrained | 6726 | 6533 | 6987 | 168/18 |
| prefill: short prompt, 1 token out | 1767 | 1733 | 2026 | 52/1 |
| prefill: long prompt, 1 token out | 5147 | 4894 | 5300 | 151/1 |
| decode: 1 token out | 721 | 679 | 803 | 22/1 |
| decode: 64 tokens out | 5293 | 5059 | 5663 | 32/64 |

