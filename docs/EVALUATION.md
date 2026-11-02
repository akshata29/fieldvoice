# Evaluation: how to pick the speech engine, the extraction model and the strategy

The demo is a measuring instrument as much as a product. Every candidate (speech-to-text engine × small language
model × extraction strategy) runs through **the same pipeline, the same cases and the same metrics**, on the target
hardware, so the choice can be made on evidence instead of leaderboard numbers.

> All shipped datasets are **synthetic** (templates + text-to-speech + simulated noise). They are excellent for
> *relative* comparisons, regression testing and finding failure modes. They are **not** a substitute for recorded
> field speech - see [Replacing synthetic data with customer data](#6-replacing-synthetic-data-with-customer-data).
> Timings taken on a developer machine say nothing about a rugged 8th-gen tablet; run the same matrix on the device.

## 1. What is compared

| Axis | Candidates (availability is discovered at runtime - `GET /api/v1/engines`, or `run_eval.bat engines`) |
|---|---|
| **Speech-to-text** | Foundry Local: Whisper tiny / base / small / medium / large-v3-turbo (offline, file-based), NVIDIA Parakeet and Nemotron streaming (offline, live partials). Azure embedded speech (offline reference; limited-access, Windows 11+, not iOS - needs credentials/model files, **untested here**). Azure cloud speech (online *accuracy ceiling*, never counted as an offline option). `oracle:stt:transcript` = the reference text, used to isolate the language-model stage from speech errors. |
| **Extraction model** | Any chat model in the Foundry Local catalog that fits the device: Qwen 2.5 / 3 / 3.5, Phi-3.5-mini / Phi-4-mini, Ministral-3, Gemma, SmolLM3, ... plus `rules:llm:none` (deterministic only). |
| **Strategy** | The ablation ladder, from "what the prototype does today" to the proposed design. |

Strategy ladder (`backend/core/strategies.py`):

| id | What it does | Why it is in the ladder |
|---|---|---|
| `free_json` | One prompt containing the whole form; free-form JSON; lenient parse. | Re-creation of the current prototype's approach as it was described to us (about 45 s per extraction). The prompt is a **reconstruction** - drop the real one into `data/baseline_prompt.txt` to override it. |
| `schema_constrained` | Same prompt, JSON-schema constrained decoding. | Does constraining the output alone fix quality/latency? (Short answer from our probe: guarantees *shape*, not *correctness*.) |
| `enum_grammar` | LLM only, tight grammar (enums, candidate-restricted ids, compact output). | Best LLM-only approach. |
| `hybrid` | Normalize → deterministic closed-world resolver → LLM **only** for fields still unresolved **and** only when unexplained words remain → validate. | The proposal: most utterances never call the model. |
| `hybrid_always` | Like `hybrid` but always asks the LLM about unresolved fields. | Isolates the value of the "residual words" gate. |
| `rules_only` | Deterministic stages only. | Floor/lower bound, and the no-model fallback. |

**The language-model prompt is a second axis.** The hybrid strategy's prompt is selectable with `FV_PATCH_PROMPT`
(`backend/core/prompts.py`), so prompts are compared like models, on the same data:

| id | What changes | Verdict on our data |
|---|---|---|
| `v0` | The original: allowed values as codes, "use null for anything the statement does not say, never guess". | Cautious to a fault: a 1.5B model answers `null` for most slang. |
| `v1` | "Closest in meaning" instruction, same layout. | Within noise of v0 (±1 point), a few more wrong guesses. |
| `v2` / `v3` | Options listed with their labels / labels + two synonyms. | v3 +3 points but 2-3x the latency (twice the prompt tokens). Not worth it. |
| `v4` (**default**) | Each enum field is asked as `{"mentioned": true\|false, "value": <option>}`: abstention is a yes/no answer, the value is a forced choice (the grammar has no `null` for enums). | Much better recall on slang for ~+0.8 s per call; more (always flagged) suggestions, some wrong. See [RESULTS.md](RESULTS.md). |

Prompts are **tuned on `prompt-dev`** (78 hand-written colloquial statements, disjoint from the held-out phrase bank;
`python -m backend.synth.prompt_dev`) and **reported on `synth-v1` held-out**. Tuning on the held-out split would make the
reported number a training number. The LLM-only baselines (`free_json`, `schema_constrained`, `enum_grammar`) keep their own
prompts whatever `FV_PATCH_PROMPT` says.

## 2. Metrics (what each number means)

Everything is computed per (config × case) and aggregated per config (`backend/evalkit/metrics.py`).

**Speech**

* **WER** - word error rate against the *spoken* reference (numbers as words). Punishes "pole 123" vs "pole one two three".
* **WER (normalized)** - WER after the number/format normalizer, i.e. the error that actually matters downstream.
* **Identifier exact match** - share of identifiers/numbers in the reference that appear correctly in the transcript.
  A single wrong digit in a pole id is the failure mode that costs money, so this is tracked separately.
* **RTF** - STT time ÷ audio time (< 1 is faster than real time).

**Extraction** (fields are scored against `expected`; an expected-empty field must stay empty)

* **Field accuracy** - micro-average over all (case, field) pairs.
* **ID-field accuracy** - accuracy on entity-reference fields only (pole, removed unit, replacement unit, ...).
* **Silent-wrong rate** - *confident* (status `filled`, confidence ≥ threshold) **and** wrong, as a share of confident
  fields. This is the headline safety number: a wrong value the worker is not warned about.
* **Hallucination rate** - share of expected-empty fields that were filled.
* **Review rate** - share of fields flagged for the worker (`needs_review` / `conflict`). Higher is more work for the
  worker; lower is better only if silent-wrong stays low.
* **Safe-outcome rate** - correct **or** flagged. `1 - safe_outcome_rate` is the share of fields that are wrong *and*
  unflagged.
* **Schema-valid rate** - LLM output parsed and valid (only when an LLM was called).
* **Form exact match** - every scored field in a form correct.

**Cost**

* **Latency p50 / p95 / max** - `total` = end of speech → proposed fields, **including STT** when a real engine is used;
  also split into `stt`, `extract` (everything after STT) and `llm`. One-off model load is reported separately as
  **cold start**.
* **Tokens** - prompt and output tokens per LLM call (real counts from the Foundry session when available).
* **Peak RAM** - the models' resident footprint as a delta over the process baseline, STT and LLM phases summed
  (sampled in the background while the phase runs).
* **Model size** - on-disk size of the models used.

## 3. Decision gates

`GET /api/v1/eval/runs/{id}/decision` (and the **Results → Decision** view, and `run_eval.bat report <run_id>`) applies
gates, ranks the survivors and marks the Pareto front (latency vs accuracy vs silent-wrong):

| Gate | Default | Meaning |
|---|---|---|
| `max_p95_ms` | 5000 | p95 end-of-speech → proposed fields |
| `min_id_field_accuracy` | 0.95 | identifier fields |
| `max_silent_wrong` | 0.02 | confident-and-wrong share |
| `max_peak_rss_mb` | off | set from the device's free RAM |
| `min_field_accuracy` | 0 | optional floor |

The defaults are starting points chosen for a field-form workflow, **not customer requirements** - agree them with the
customer, then re-run the decision view; no re-run of the models is needed.

## 4. Datasets

`data/datasets/<id>/` = `manifest.json`, `world.json` (assets/forms/work orders the cases refer to), `cases.jsonl`
(`EvalCase` per line), `audio/<case>.wav` (16 kHz mono PCM16).

* Cases come from templates × a lexicon (asset names, conditions, units, colloquialisms) × correction/negation/missing-
  field patterns. **Tags** (`digits`, `grouped`, `correction`, `negation`, `missing`, `colloquial`, noise kinds, ...) let
  every metric be sliced.
* **Splits**: `dev` (templates/lexicon the rules were tuned on) and `heldout` (colloquial phrasing disjoint from the
  lexicon). Quote **held-out** numbers when talking about generalization - dev numbers flatter the deterministic stage.
* Audio is synthesized with the Windows speech voices installed on the machine, then (optionally) degraded with noise
  (white, pink, wind, engine, crackle, radio, muffled) at set SNRs.
* Generate: `scripts\build_dataset.bat` or **Results → Datasets → Generate**.
  Details and limits: [DATASET.md](DATASET.md).

## 5. Running it

UI: **Evaluation** page → pick STT engines, LLMs and strategies → *Run*. Progress streams live; results are stored under
`data/runs/<run_id>/` (`summary.json`, `cases.jsonl`, `report.md` for CLI runs) and can be exported (CSV / JSON / Markdown).

CLI (repo root):

```bat
scripts\run_eval.bat engines
scripts\run_eval.bat run --llm foundry:llm:qwen2.5-0.5b:cpu --strategy free_json --strategy hybrid --limit 60
scripts\run_eval.bat run --stt foundry:stt:whisper-base:cpu --stt foundry:stt:nemotron-speech-streaming-en-0.6b:cpu --strategy rules_only
scripts\run_eval.bat report <run_id>
scripts\run_eval.bat rescore <run_id>
```

**Re-scoring a finished run.** `rescore` takes the transcripts a speech run stored, runs extraction and scoring again with
the *current* code, and writes a new run (label `<old label>-rescored`, same hardware and speech timings, a note naming the
source). Use it after changing the normalizer, resolver or lexicon: the speech engines' words do not change, so the audio
hour is not repeated (the hyphen fix in [RESULTS.md](RESULTS.md#1-speech-to-text) re-scored five engines in seconds).
Configurations that call a language model are skipped (re-run those), and transcripts whose reference no longer matches the
dataset (it was rebuilt since) are refused rather than scored against the wrong answers.

**Device probe first.** On a new device (the target tablet!) run `scripts\bench_device.bat` before the full matrix. It takes
about a minute per engine and answers "is this engine even feasible here, and where does its time go?": speech
real-time factor on one clip (repeated); with `--live`, a streaming engine fed the clip in real time (time to the first
words and the wait after the last word - what the worker feels); and the language-model call the hybrid pipeline makes - one
field and three fields, grammar-constrained / JSON-schema-constrained / unconstrained - plus four controlled calls that
separate session setup, the cost of one prompt token and the cost of one generated token.

```bat
scripts\bench_device.bat --stt foundry:stt:whisper-base:cpu --stt foundry:stt:whisper-small:cpu --llm foundry:llm:qwen2.5-1.5b:cpu
scripts\bench_device.bat --stt foundry:stt:nemotron-speech-streaming-en-0.6b:cpu --live
```

How a run executes (`backend/evalkit/runner.py`):

1. **Phase A - speech.** For each STT engine: unload everything, load the engine, one untimed warm-up, transcribe every
   audio case once (cached), unload. RAM is sampled.
2. **Phase B - extraction.** For each config: load the LLM (cold start measured), untimed warm-up cases, then every case
   (× `repeats`). Latency totals add the cached STT time so a (STT × LLM × strategy) cell reflects the whole path.
3. Metrics aggregate, the summary is saved after every config (so a partial run is still readable), the decision
   report is computed on demand.

Tips for trustworthy numbers: run on AC power with the *High performance* plan; close other apps; `repeats ≥ 3` for
latency percentiles; set `FV_DEVICE_PROFILE=latitude-7220` so the profile is stamped on every run; note that the first
run of a model also pays a disk/page-cache cost that "cold start" captures.

## 6. Replacing synthetic data with customer data

Nothing else changes - drop real material into the same shape:

1. **Audio**: 16 kHz mono PCM16 WAV files, recorded on the *actual tablet microphone / headset in the field* (truck cab,
   substation, wind). Convert with `ffmpeg -i in.m4a -ar 16000 -ac 1 -sample_fmt s16 out.wav`.
2. **Ground truth**: one `EvalCase` per recording in `cases.jsonl` (`spoken_text` = what was said, `written_text` = how
   a good transcript reads, `expected` = the correct value per form field, `tags`, `split`).
3. **Forms and reference data**: the customer's real form definitions and a sample of real asset ids go into
   `world.json` (`DemoWorld`) so the closed world matches reality (id formats, naming, abbreviations).
4. **The prototype prompt** into `data/baseline_prompt.txt` so the `free_json` baseline is really *their* baseline.
5. Re-run the same matrix; compare synthetic vs real accuracy per tag - the gap is the honest measure of how much the
   synthetic proxy overstated things.

Even 100-150 well-labelled real utterances are enough to confirm or overturn the ranking; they do not need to be many
to expose where the synthetic data is too clean.

## 7. Threats to validity (read before quoting a number)

* Synthetic speech is cleaner and more regular than people; noise augmentation helps but does not reproduce accents,
  hesitations, radio chatter or crosstalk.
* The lexicon and templates were written by the same team as the deterministic rules - hence the held-out split, which
  is better but not independent. Real data is the only independent test.
* The `free_json` prompt is a reconstruction of the customer's current prompt, so absolute baseline numbers are
  indicative only.
* Peak RAM is an estimate (delta of process RSS), not a profiler measurement; on-device accelerators (NPU/GPU) are not
  exercised by default - the SDK's automatic variant selection chose an NPU variant that failed to load on the dev box,
  so variants are pinned to CPU unless opted in.
* Latency on the development machine is not representative of the target tablet. Do not extrapolate.
