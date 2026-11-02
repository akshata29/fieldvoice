# Device probe - profile `dev-box-quiet`

- Intel(R) Core(TM) Ultra 7 165H (16C/22T), 63.6 GB RAM, Windows 11
- _Not a field-fleet device: results rank options only and are not representative of the Latitude 7220 (8th-gen U-series CPU, <=16 GB LPDDR3, no NPU)._
- _This CPU has an NPU; auto-selected NPU variants may be used unless variants are pinned._

## Language model `foundry:llm:phi-3.5-mini:cpu`

Cold start 11399 ms, about 3239 MB resident.
Fixed cost per call (session setup): 0 ms; prompt: 38.4 ms per token; generation: 73.2 ms per token (14 tokens/s).

| Call | p50 ms | best ms | worst ms | Tokens in/out |
|---|---|---|---|---|
| 1 field, grammar | 7372 | 6841 | 7647 | 142/12 |
| 1 field, json schema | 7703 | 7453 | 8681 | 142/17 |
| 1 field, unconstrained | 8538 | 8354 | 8887 | 142/26 |
| 3 fields, grammar | 9506 | 9468 | 9664 | 183/21 |
| 3 fields, json schema | 11552 | 10928 | 12639 | 183/42 |
| 3 fields, unconstrained | 10326 | 9878 | 12057 | 183/54 |
| prefill: short prompt, 1 token out | 1658 | 1460 | 2007 | 46/1 |
| prefill: long prompt, 1 token out | 5576 | 4760 | 6404 | 148/1 |
| decode: 1 token out | 647 | 583 | 660 | 15/1 |
| decode: 64 tokens out | 5682 | 5604 | 6842 | 26/64 |

