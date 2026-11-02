# Device probe - profile `dev-box-quiet`

- Intel(R) Core(TM) Ultra 7 165H (16C/22T), 63.6 GB RAM, Windows 11
- _Not a field-fleet device: results rank options only and are not representative of the Latitude 7220 (8th-gen U-series CPU, <=16 GB LPDDR3, no NPU)._
- _This CPU has an NPU; auto-selected NPU variants may be used unless variants are pinned._

## Language model `foundry:llm:phi-4-mini:cpu`

Cold start 14024 ms, about 4093 MB resident.
Fixed cost per call (session setup): 204 ms; prompt: 34.9 ms per token; generation: 92.1 ms per token (11 tokens/s).

| Call | p50 ms | best ms | worst ms | Tokens in/out |
|---|---|---|---|---|
| 1 field, grammar | 5527 | 5071 | 5706 | 121/6 |
| 1 field, json schema | 5670 | 5577 | 5816 | 121/10 |
| 1 field, unconstrained | 5838 | 5452 | 6200 | 121/14 |
| 3 fields, grammar | 7203 | 7011 | 7371 | 155/18 |
| 3 fields, json schema | 11081 | 10238 | 11683 | 155/54 |
| 3 fields, unconstrained | 9972 | 9790 | 10102 | 155/40 |
| prefill: short prompt, 1 token out | 1598 | 1486 | 1665 | 40/1 |
| prefill: long prompt, 1 token out | 4630 | 4458 | 4810 | 127/1 |
| decode: 1 token out | 598 | 545 | 674 | 14/1 |
| decode: 64 tokens out | 6713 | 6622 | 6781 | 23/64 |

