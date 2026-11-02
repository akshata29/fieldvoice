# Device probe - profile `dev-box-quiet`

- Intel(R) Core(TM) Ultra 7 165H (16C/22T), 63.6 GB RAM, Windows 11
- _Not a field-fleet device: results rank options only and are not representative of the Latitude 7220 (8th-gen U-series CPU, <=16 GB LPDDR3, no NPU)._
- _This CPU has an NPU; auto-selected NPU variants may be used unless variants are pinned._

## Language model `foundry:llm:qwen2.5-1.5b:cpu`

Cold start 7046 ms, about 1377 MB resident.
Fixed cost per call (session setup): 0 ms; prompt: 17.6 ms per token; generation: 31.3 ms per token (32 tokens/s).

| Call | p50 ms | best ms | worst ms | Tokens in/out |
|---|---|---|---|---|
| 1 field, grammar | 2407 | 2180 | 2593 | 134/6 |
| 1 field, json schema | 2666 | 2498 | 2922 | 134/12 |
| 1 field, unconstrained | 3059 | 2944 | 3247 | 134/25 |
| 3 fields, grammar | 3432 | 3225 | 3476 | 168/18 |
| 3 fields, json schema | 3789 | 3713 | 4177 | 168/32 |
| 3 fields, unconstrained | 3710 | 3653 | 3861 | 168/29 |
| prefill: short prompt, 1 token out | 833 | 828 | 860 | 52/1 |
| prefill: long prompt, 1 token out | 2573 | 2306 | 2705 | 151/1 |
| decode: 1 token out | 579 | 570 | 595 | 34/1 |
| decode: 64 tokens out | 2554 | 2510 | 2679 | 34/64 |

