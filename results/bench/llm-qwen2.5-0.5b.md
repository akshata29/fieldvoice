# Device probe - profile `dev-box-quiet`

- Intel(R) Core(TM) Ultra 7 165H (16C/22T), 63.6 GB RAM, Windows 11
- _Not a field-fleet device: results rank options only and are not representative of the Latitude 7220 (8th-gen U-series CPU, <=16 GB LPDDR3, no NPU)._
- _This CPU has an NPU; auto-selected NPU variants may be used unless variants are pinned._

## Language model `foundry:llm:qwen2.5-0.5b:cpu`

Cold start 3953 ms, about 503 MB resident.
Fixed cost per call (session setup): 0 ms; prompt: 6.5 ms per token; generation: 12.8 ms per token (78 tokens/s).

| Call | p50 ms | best ms | worst ms | Tokens in/out |
|---|---|---|---|---|
| 1 field, grammar | 836 | 822 | 1004 | 134/6 |
| 1 field, json schema | 1034 | 948 | 1191 | 134/12 |
| 1 field, unconstrained | 1169 | 1107 | 1246 | 134/26 |
| 3 fields, grammar | 1271 | 1234 | 1533 | 168/18 |
| 3 fields, json schema | 1477 | 1426 | 1559 | 168/31 |
| 3 fields, unconstrained | 1722 | 1638 | 2177 | 168/54 |
| prefill: short prompt, 1 token out | 303 | 299 | 326 | 52/1 |
| prefill: long prompt, 1 token out | 948 | 854 | 1204 | 151/1 |
| decode: 1 token out | 213 | 204 | 237 | 34/1 |
| decode: 64 tokens out | 1020 | 979 | 1275 | 34/64 |

