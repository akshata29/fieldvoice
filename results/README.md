# Evaluation evidence

The evaluation runs and device benchmarks behind the numbers in [docs/RESULTS.md](../docs/RESULTS.md), exactly as the
evaluation harness stored them. Everything here is **synthetic** (templated statements spoken by Windows text-to-speech,
optionally with simulated noise) and was measured on **one developer laptop** (Intel Core Ultra 7 165H, 64 GB, Windows 11),
**not** on the field tablets. The numbers rank options against each other on identical input; they are not predictions of
field accuracy or tablet latency. See the "Read this first" note in RESULTS.md.

## What is in here

```
results/
  runs/<run_id>/summary.json   configuration, hardware, per-configuration metrics (accuracy, silent-wrong, latency, memory)
  runs/<run_id>/cases.jsonl    one line per case and configuration: the transcript heard, expected vs extracted fields
  runs/<run_id>/report.md      the decision report (gates and ranking) as printed by the CLI
  bench/*.json, *.md           device probes: speech real-time factor, streaming wait, language-model call cost
```

Run ids are UTC timestamps. `device_profile` in a run's hardware block says how busy the laptop was: `dev-box-quiet` =
otherwise idle, `dev-box-shared` = other applications were running (latencies are higher). Runs whose label ends in
`-rescored` re-use the speech transcripts of an earlier run and re-run only the extraction and scoring after a normalizer fix
(`scripts\run_eval.bat rescore <run_id>`; see docs/EVALUATION.md).

## Look at them in the app

```bat
scripts\load_sample_results.bat      :: copies results\runs into data\runs
scripts\run_demo.bat                 :: then open Results - Runs
```

Or read `runs/<run_id>/report.md` directly on GitHub.

## Index

**Speech-to-text sweeps** (120 audio clips, rules-only extraction) - RESULTS.md section 1

| Run | Label | Engines |
|---|---|---|
| `20261030-190732-9d6a37` | stt-sweep-whisper (shared CPU) | Whisper tiny, base, small - as measured |
| `20261030-231428-4524dd` | stt-sweep-medium-nemotron | Whisper medium, Nemotron streaming - as measured |
| `20261030-234629-8fc068` | stt-sweep-whisper-rescored | the first sweep re-scored with the final normalizer (the numbers quoted) |
| `20261030-234636-93ea73` | stt-sweep-medium-nemotron-rescored | the second sweep re-scored the same way |

**Language-model ladder** (held-out split, 63 cases, correct transcript, `hybrid` strategy) - section 2.2

| Run | Label |
|---|---|
| `20261030-214332-b49d27` | ladder-heldout-rules-only |
| `20261030-214333-830469` | ladder-heldout-qwen2.5-0.5b |
| `20261030-214450-f2b78f` | ladder-heldout-qwen2.5-1.5b |
| `20261030-214754-c9c554` | ladder-heldout-qwen2.5-3b |
| `20261030-215342-6dbb1e` | ladder-heldout-phi-3.5-mini |
| `20261030-220133-55b66d` | ladder-heldout-ministral-3-3b-instruct-2512 |
| `20261030-220829-fc39e2` | ladder-heldout-phi-4-mini |

**Prompt wording** (how the model is asked) - section 2.3

| Run | Label | Notes |
|---|---|---|
| `20261030-205626-42baf3` | pv-rules-only | 78 colloquial lines (`prompt-dev`), no model |
| `20261030-205627-c8da81`, `-205815-36a273`, `-210129-19c8a1`, `-210602-c550d2`, `-213033-d3e517` | pv-qwen2.5-1.5b-v0 ... v4 | five wordings, 1.5B model |
| `20261030-211147-f248e0`, `-211814-d2384b` | pv-qwen2.5-3b-v0, v1 | two wordings, 3B model |
| `20261030-213747-65a7f8`, `-213441-73aef5` | heldout-qwen2.5-1.5b-v0, v4 | the old and the default wording on the held-out split |

**End to end** (real speech through Whisper, then extraction; 36 held-out clips) - section 3

| Run | Label | Notes |
|---|---|---|
| `20261030-221648-364615` | e2e-heldout-rules | Whisper base and small, rules only |
| `20261030-235232-76aef4` | e2e-heldout-rules-rescored | the same, re-scored with the final normalizer |
| `20261030-222002-79be0f` | e2e-heldout-hybrid | Whisper base/small x Qwen 1.5B/3B, hybrid (ran before the normalizer fix; one clip is affected) |

**Strategy ablation** (what each layer buys; correct transcript) - section 4

| Run | Label | Notes |
|---|---|---|
| `20261030-223427-7f50ba` | llmonly-enum_grammar-qwen2.5-1.5b | model answers every enum field itself |
| `20261030-223953-f8f75e` | llmonly-enum_grammar-qwen2.5-3b | |
| `20261030-224911-717c4f` | llmonly-enum_grammar-ministral-30 | first 30 cases |
| `20261030-225422-36102f` | llmonly-baselines-qwen2.5-3b-20 | free JSON and schema-constrained, first 20 cases |
| `20261030-192045-d88b89` | qwen0.5b heldout (shared CPU) | 0.5B model, earlier code, loaded machine |

**Smoke check**

| Run | Label | Notes |
|---|---|---|
| `20261030-200145-37cfb1` | demo-rules-oracle | the 11 scripted demo lines, rules only |

## Reproducing and replacing

`docs/RESULTS.md` ends with the exact commands. To judge the options on *your* data, add real recordings and forms
(docs/EVALUATION.md section 6) and run the same matrix on the target device; `scripts\bench_device.bat` is the quick first step.
