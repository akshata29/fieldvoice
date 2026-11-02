# Synthetic dataset

Everything the demo and the evaluation use is **synthetic**: fictional workers, assets, forms and procedures, spoken
statements generated from templates, speech synthesized with the Windows voices, and optional simulated field noise.
Nothing here is customer data and none of the procedure text is an operating procedure (each document says so).

Why synthetic? The customer's real forms, asset lists and recordings are not available yet. Synthetic data is enough to
(a) run the whole product end to end, (b) compare engines and strategies *relative to each other* on identical input,
(c) regression-test the extraction logic, and (d) expose failure modes early - it did all four (see
[What the data found](#what-the-data-found)). It is **not** enough to predict field accuracy; see
[EVALUATION.md](EVALUATION.md#6-replacing-synthetic-data-with-customer-data) for how to swap in real recordings.

## What is generated

| Piece | Module | Notes |
|---|---|---|
| World (workers, assets, KB, work orders) | `backend/synth/world.py` | Deterministic per seed. The call's headline job always exists: pole **123**, old transformer **T9921**, stock unit **456**, plus near-miss neighbours (132, 213, 321, 465, 546) so a misheard digit is still a *valid* id. Demo PIN for every worker is `1234`. |
| Forms | `backend/synth/lexicon.py` | `transformer_replacement`, `pole_inspection`, `meter_exchange`, `outage_restoration` (enum, entity-reference, number, boolean and free-text fields). |
| Utterances | `backend/synth/utterances.py` | `EvalCase` per statement: `spoken_text`, `written_text`, `expected` per field, `tags`, `split`, the job's closed world (`job_asset_ids`). |
| Speech | `backend/synth/tts.py` | Windows PowerShell + `System.Speech` (David, Zira), one batched process, 16 kHz mono PCM16. No pip dependency. |
| Noise | `backend/synth/augment.py` | numpy only: white, pink, wind, engine hum, radio crackle, band-limited "radio", muffled; SNR 20/15/10/5 dB; optional reverb. |
| Builder | `backend/synth/build_dataset.py` | `python -m backend.synth.build_dataset ...` or `POST /api/v1/eval/datasets/generate`. |
| Demo script | `backend/synth/demo_script.py` | The 11 hand-written lines of the live demo (dataset `demo-script`), see [below](#the-scripted-demo-set). |

```bat
scripts\build_dataset.bat                                   :: synth-v1 (240 cases, speech for 120, half of those noisy) + demo-script
scripts\build_dataset.bat --cases 60 --audio-limit 20       :: quick
.venv\Scripts\python.exe -m backend.synth.build_dataset --name quick --cases 40            :: text only, no speech
.venv\Scripts\python.exe -m backend.synth.demo_script                                       :: only the demo lines
```

Layout: `data/datasets/<name>/` = `manifest.json` (`EvalDatasetInfo`), `world.json` (`DemoWorld`), `cases.jsonl`
(`EvalCase` per line), `audio/<case>.wav`. Builds are deterministic for a given `--seed` (the default `synth-v1` takes
roughly ten seconds, most of it speech synthesis).

## Splits and tags

* **`dev`** (about 75 %) - phrasing taken from the forms' lexicon. The deterministic stages were tuned against these.
* **`heldout`** (about 25 %) - colloquial phrasing that is **not** in the lexicon ("the old unit was weeping badly",
  "hung a fresh transformer", "a cutout let go"). Quote held-out numbers when you talk about generalization.

| Tag | Meaning |
|---|---|
| `digits` / `grouped` / `nato` | how ids were spoken: "one two three", "one twenty three", "alpha seven seven" |
| `correction` | "pole 123, sorry, 132" - the later id wins |
| `negation` | "the customer was not notified", "the unit was not leaking" |
| `distractor` | an irrelevant number ("work order 3084") that must not become an asset id |
| `number` | quantities with units (kVA, feet, kWh, customers) |
| `missing_required` | the worker forgot a required field; it must stay empty, never be guessed |
| `colloquial` | held-out phrasing for at least one enum |
| `clean` / `noisy`, `noise_<kind>`, `snr_<dB>`, `reverb` | audio condition (audio cases only) |

Closed worlds contain a confusable twin of the target id about a third of the time, so an ASR digit error that lands on a
valid neighbour shows up as a **silent-wrong** error - the failure the metrics are designed to expose.

## The scripted demo set

`demo-script` is a separate, tiny dataset of **hand-written** lines for the demo technician's three jobs (WO-10231
transformer at pole 123, WO-10232 transformer at pole 374, WO-10235 pole inspection at E9). Each line has audio, ground
truth and the job's own closed world, so it plays on the job page (it is the first thing the sample picker offers), compares
in the Lab, and evaluates in about a minute.

| Line | What it shows |
|---|---|
| `demo-01` | **The sentence from the call**, word for word. The removed unit (T9921) comes from dispatch, not from speech. |
| `demo-02` | Every field spoken: grouped digits ("four fifty six"), a letter id in the phonetic alphabet, a boolean. |
| `demo-03` | A spoken self-correction ("pole 132, sorry, 123"): the last id wins, and 132 is a real neighbour. |
| `demo-04`, `demo-10` | Slang the lexicon does not contain ("did a change-out on the can", "pecked up"): the rules leave fields open and the model's suggestions arrive marked *needs review*. |
| `demo-05` | A work-order number that is not an asset, plus a negation ("not leaking" means no issues). |
| `demo-06` | The replacement unit is never said: a required field stays open instead of being guessed. |
| `demo-07` | A quantity with a unit ("twenty five k v a"). |
| `demo-08`, `demo-09` | The other two jobs: a repair with an old-unit id, and a pole inspection (second form). |
| `demo-11` | The headline sentence with a truck engine idling behind it (10 dB SNR) - same words, so any change is the audio. |

A test (`backend/tests/synth/test_demo_script.py`) keeps the set honest: every non-slang line must be solved by the
deterministic stage with zero silent-wrong fields, and the slang lines must *not* be.

## The prompt-tuning set

`prompt-dev` (`python -m backend.synth.prompt_dev`, text only) is where **prompts are tuned**: 78 hand-written statements,
three different ways of saying each option of every enum field in the four forms ("swapped the old can out for a new
one", "is shot", "had a cut seal", "a thunderstorm rolled through"). None of the phrases is a lexicon phrase (the rules alone
still get 45 % of the enum fields right through stray keywords such as "rust" or "crack") and none is in the held-out phrase
bank (the builder asserts it). Tune on this, report on `synth-v1` held-out - otherwise the reported number is a training number.

Note what it is *not* a good proxy for: in `prompt-dev` exactly one enum field per statement is mentioned, so the model is
also asked about fields nobody mentioned. That makes it a stress test for hallucination; the held-out split mentions most of
the fields the model is asked about.

## What the data found

Building the generator and running the deterministic stage over it surfaced real bugs - running small models over it
surfaced three more, and a larger speech model one more - each now covered by a regression test (`backend/tests/core`,
`backend/tests/synth`):

1. `"the customer was not notified"` was read as *notified* - a negator **inside** a gapped phrase was ignored.
2. `"old one 45863966"` was normalized to `145863966` (a pronoun swallowed as the digit 1) and `"the new one is"` became
   `"the new 1 is"`.
3. A glued id without a trigger word (`"sorry, A77"`) was split into `a` + `77` and resolved to **77**.
4. `"Checked pole 123"` matched the lexicon synonym *checking* (stem collision) and filled `defect = cracked`
   - now caught at authoring time by `lint_form()`.
5. `"no defects, applied preservative"`: the negator before the comma negated the next clause (`preservative = False`).
6. A work-order number was proposed as the removed transformer; ids already assigned were offered to the LLM as candidates
   for other fields; and two same-kind roles (old meter / new meter) with no role words were assigned with false confidence.
7. A 0.5 B model answered `customer_notified = true` for statements that never mention a customer. A boolean nobody talked
   about is *not stated*, never `false` or `true`: the model is now asked about a boolean only if the statement touches its
   topic (`FormPack.topic_stems`).
8. A 1.5 B model answered `condition_found = "none"` (shown to the worker as *No issues*) for statements that say nothing
   about the condition. It was always a *needs review* suggestion, but "No issues" is a claim nobody made: a model may now
   claim "none" only when the statement says something negative or reassuring (`FormPack.absence_supported`).
9. *"Okay pole 213, it is good to go"* never reached the model: "good" occurs in the wording of another option ("good
   condition"), so the LLM gate counted it as known vocabulary. On the held-out split the model was consulted in 44 of the 49
   cases that had something to find; after the fix, in all 49, while the dev split opens the gate exactly as often as before
   (`FormPack.structural_stems`).
10. Whisper-medium writes spoken digit groups with hyphens - *"pole 1-2-3"*, *"feeder 23-22"*, *"sorry, 3-28"* - and the
    normalizer left them as separate numbers: 8 of the 10 clips medium got wrong that small got right, so the bigger model
    first scored *below* the smaller one (89.2 vs 92.6 % id accuracy). Hyphens between short digit groups are now one number
    (not before a unit - "20-25 feet" is a range - and not in decimals or four-digit years). Re-scoring the stored
    transcripts (`run_eval.bat rescore`) put medium at 94.1 %; Whisper-tiny and -small gained 2.2 and 1.1 points.

None of these showed up in the single hand-written example from the call. That is the argument for evaluating on a
generated, labelled corpus - and for replacing it with the customer's real recordings as soon as they exist.

## Known limits

* Synthetic speech is clean, evenly paced and from two voices; it has no accents, hesitations, crosstalk or microphone
  quirks. Noise is additive/filtered, not recorded. Expect real audio to be harder.
* Templates and lexicon were written by the same team as the extraction rules; `heldout` mitigates but does not remove
  that coupling.
* The forms are plausible, not real. Asset id formats (3-4 digit poles, `T####` transformers, 8-digit meters, 4-digit
  feeders, a few `A77`-style poles) are guesses to be replaced with the customer's conventions.
* English only; US voices.
