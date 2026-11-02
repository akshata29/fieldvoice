# Device probe - profile `dev-box-quiet`

- Intel(R) Core(TM) Ultra 7 165H (16C/22T), 63.6 GB RAM, Windows 11
- _Not a field-fleet device: results rank options only and are not representative of the Latitude 7220 (8th-gen U-series CPU, <=16 GB LPDDR3, no NPU)._
- _This CPU has an NPU; auto-selected NPU variants may be used unless variants are pinned._

## Language model `foundry:llm:ministral-3-3b-instruct-2512:cpu`

Cold start 14301 ms, about 4011 MB resident.
Fixed cost per call (session setup): 184 ms; prompt: 31.9 ms per token; generation: 87.4 ms per token (11 tokens/s).

| Call | p50 ms | best ms | worst ms | Tokens in/out |
|---|---|---|---|---|
| 1 field, grammar | 4529 | 4331 | 5043 | 127/6 |
| 1 field, json schema | 5588 | 5005 | 5928 | 127/10 |
| 1 field, unconstrained | 6416 | 5999 | 7365 | 127/26 |
| 3 fields, grammar | 6620 | 6037 | 6732 | 162/18 |
| 3 fields, json schema | 8803 | 8060 | 9521 | 162/33 |
| 3 fields, unconstrained | 10763 | 10396 | 11238 | 162/54 |
| prefill: short prompt, 1 token out | 1589 | 1384 | 1670 | 44/1 |
| prefill: long prompt, 1 token out | 4750 | 4202 | 4827 | 143/1 |
| decode: 1 token out | 484 | 463 | 545 | 14/1 |
| decode: 64 tokens out | 6339 | 5805 | 6591 | 25/64 |

