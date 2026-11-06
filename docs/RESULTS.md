# Results on the dev box (synthetic data)

What the evaluation harness measured, how to read it, and what it does and does not tell you about the field fleet.

> **Read this first.** Everything here is **synthetic** (templates, Windows text-to-speech, simulated noise) and was
> measured on one developer machine - Core Ultra 7 165H (16 cores), 64 GB, Windows 11 - **not** on the Dell Latitude 7220
> Rugged Extreme (8th-gen U-series, 4 cores, LPDDR3, no NPU). The numbers *rank options against each other on identical
> input*. They are not predictions of field accuracy or tablet latency; the sizing section says what to expect and what to
> measure. Every run is stored under `data/runs/<id>/` and opens in **Results**; every table below can be regenerated
> (commands at the end).

## 0. The answer in seven lines

1. **Rules + the job's closed world are the backbone, not the model.** With a correct transcript they get every id right
   (100 % id-field accuracy, 0 silent-wrong) in about a millisecond; the model only has to deal with slang.
2. **Speech-to-text is the id-accuracy bottleneck.** Whisper tiny / base / small / medium reach 84 / 90 / 94 / 94 % id-field
   accuracy on synthetic audio (Nemotron streaming 89 %); none clears a 95 % gate and medium buys nothing over small. The
   closed world turns most misses into *flagged* fields (silent-wrong 0-0.7 %).
3. **Whisper-base is the sensible default** (RTF 0.14 here, 159 MB); small buys +1.5 points of field accuracy and +3 of id
   accuracy for 3x the time; medium is slower than real time (RTF 1.16) for no further gain.
4. **Streaming removes the wait - on this machine.** Nemotron shows the final text 0.19 s after the speaker stops (batch Whisper:
   1.2-9.5 s) at the accuracy of Whisper-base, but it drops spoken corrections ("sorry, 328") and only hides latency while its
   RTF stays under 1 (0.45 here; unmeasured on the tablet).
5. **A small model that may answer `null` mostly does.** Reformulating the question (separate "was it mentioned?" from the
   value) moved Qwen2.5-1.5B from 45 % to 77 % enum accuracy on held-out slang, for about +0.8 s a call.
6. **Model size then matters:** held-out enum accuracy 49 / 77 / 94 % for Qwen2.5 0.5B / 1.5B / 3B; Ministral-3-3B and
   Phi-4-mini tie the 3B at 94 %, Phi-3.5-mini 90 %. Every model answer stays *needs review*: silent-wrong 0 % throughout.
7. **Latency is prompt prefill.** 18 ms per prompt token for a 1.5B model on this machine (6.5-38 ms across the six), about 90 % of
   a call; generation 11-78 tokens/s. Expect the tablet to be several times slower - so the design shows rules results at once
   and lets model suggestions arrive afterwards.

## 1. Speech-to-text

Two runs of `rules_only` on real audio (120 synthetic clips of `synth-v1`, half with simulated noise): Whisper tiny / base /
small (`stt-sweep-whisper`) and Whisper medium + Nemotron streaming (`stt-sweep-medium-nemotron`), both **re-scored with the
final normalizer** (`run_eval.bat rescore`, same transcripts - see the hyphen note below). The time columns come from a
separate quiet-machine probe (`scripts\bench_device.bat --live`, one 8.2 s clip, 5 repeats, all five engines back to back).

| Engine | Field acc | **Id-field acc** | Silent-wrong | WER (normalized) | Id exact match | Clean / noisy field acc | Spoken corrections (14 clips) | Wait after the speaker stops (RTF) | Cold start | Resident |
|---|---|---|---|---|---|---|---|---|---|---|
| whisper-tiny | 87.2 % | 84.4 % | 0.4 % | 17.8 % | 81 % | 91.3 / 83.6 % | 92.3 % | 0.77 s (0.09) | 1.7 s | 113 MB |
| **whisper-base** | 90.2 % | 90.3 % | 0.3 % | 13.6 % | 90 % | 91.9 / 88.6 % | 97.4 % | 1.15 s (0.14) | 2.3 s | 159 MB |
| whisper-small | 91.7 % | 93.7 % | 0.0 % | 6.8 % | 96 % | 91.9 / 91.5 % | 97.4 % | 3.65 s (0.45) | 3.5 s | 379 MB |
| whisper-medium | 92.0 % | 94.1 % | 0.3 % | 6.7 % | 97 % | 92.5 / 91.5 % | 97.4 % | 9.5 s (1.16) | 4.3 s | 930 MB |
| nemotron-0.6b (streaming) | 89.9 % | 89.2 % | 0.7 % | 7.1 % | 90 % | 90.1 / 89.7 % | 88.5 % | **0.19 s** live (3.7 s as a batch) | 2.2 s | 483 MB |

Absolute times drift by up to 1.5x between sessions (an earlier probe of the same machine, busier, measured 1.24 / 1.97 /
5.37 s for tiny / base / small); the ratios hold.

* **Size helps, with diminishing returns.** Id accuracy 84 -> 90 -> 94 -> 94 %: medium runs slower than real time (RTF 1.16) and
  needs 2.5x the memory of small for +0.4 points, which is inside the noise of 120 clips. Nothing clears a 95 % id gate on
  noisy synthetic audio; what the speech engines get wrong, the closed world turns into *flagged* fields (silent-wrong 0-0.7 %).
* **What moves the number:** id digits, not words. Noise hurts the smallest model most (tiny 91 -> 84 %); small and medium
  barely notice it (92 -> 91.5 %). White noise and engine hum are the worst conditions for every engine.
* **Number style differs per engine** on the same clip: base writes "pole 123", tiny and small "pole 1 2 3", medium
  "pole 1-2-3", Nemotron "pole one two three" with almost no punctuation. The normalizer absorbs all of them - after the fix below.
* **Found by this run - hyphenated digits.** Whisper-medium writes spoken digit groups with hyphens ("pole 1-2-3", "feeder
  23-22", "sorry, 3-28") and the normalizer did not join them, so medium first scored **89.2 %** id accuracy, *below* small.
  A normalizer rule (hyphens between short digit groups are one number, except before a unit: "20-25 feet") plus regression
  tests fixed it; re-scoring the stored transcripts - no re-transcription - moved medium 89.2 -> 94.1 %, small 92.6 -> 93.7 %,
  tiny 82.2 -> 84.4 %, base 90.0 -> 90.3 %. A new engine can look worse than it is because of glue code: read its failures before
  trusting a ranking.
* **Streaming (Nemotron): the wait disappears, the corrections do not survive.** Fed the clip in real time, the first words
  appear 0.7 s after the speaker starts and the final text **0.19 s after the last word**, against 1.2 s (base) to 9.5 s
  (medium) of waiting for the batch engines. Accuracy equals Whisper-base (89.9 vs 90.2 % field) at 3x the memory. But it
  drops spoken-correction words - "sorry", "wait" and the like survived in 6 of 14 clips (Whisper: 13-14 of 14) - so "pole 123,
  sorry, 328" often arrives as one long number and correction clips score 88.5 % against 97.4 %. And streaming hides latency only
  while the engine keeps up: RTF 0.45 leaves a 2x margin here; on a tablet 4-6x slower it would fall behind (section 5).
* **Held-out audio subset (36 clips, colloquial phrasing):** base 76.1 % field / 81.8 % id, small 77.0 % / 84.4 %,
  silent-wrong 0 % for both (the share the rules cannot read is slang - the next section).
* **Not measured:** Whisper large-v3-turbo (in the catalog, not downloaded), Parakeet (rejects file transcription), and
  **Azure Speech** (embedded and cloud engines are implemented and appear in the Lab, but need credentials / model access; see
  [Azure Speech](#azure-speech-what-is-missing)). Whisper "initial prompt" biasing toward the day's ids is **not available**
  through Foundry Local: the field is ignored (identical transcripts with and without it).

## 2. The extraction stage

### 2.1 Where the time goes (device probe, quiet machine)

`scripts\bench_device.bat --llm <engine>`: the hybrid pipeline's call (a 120-140 token prompt, one field, grammar-constrained
output), five repeats after a warm-up, plus four controlled calls that separate a call's cost into session setup, one prompt
token (the same one-token answer after a short and after a long prompt) and one generated token (a one-token against a
64-token answer to the same prompt).

| Model | Cold start | Resident | 1-field call (p50) | 3-field call (p50) | Prefill per prompt token | Generation |
|---|---|---|---|---|---|---|
| qwen2.5-0.5b | 4.0 s | 0.5 GB | 0.84 s | 1.3 s | 6.5 ms | 78 tok/s |
| qwen2.5-1.5b | 7.0 s | 1.4 GB | 2.4 s | 3.4 s | 17.6 ms | 32 tok/s |
| qwen2.5-3b | 10.9 s | 2.7 GB | 5.1 s | 6.9 s | 34 ms | 15 tok/s |
| phi-3.5-mini (3.8B) | 11.4 s | 3.2 GB | 7.4 s | 9.5 s | 38 ms | 14 tok/s |
| ministral-3-3b | 14.3 s | 4.0 GB | 4.5 s | 6.6 s | 32 ms | 11 tok/s |
| phi-4-mini (3.8B) | 14.0 s | 4.1 GB | 5.5 s | 7.2 s | 35 ms | 11 tok/s |

Probes of the same machine differ by 10-30 % from one session to the next (an earlier one measured the 3B call at 4.0 s and
the 1.5B call at 2.3 s), so the order *within* the 3-4B group is not stable; the gaps between size classes are.

* **A call's cost is almost entirely its prompt.** Session setup is 0-0.2 s; prefill is about 90 % of a call (the 1.5B model
  spends 2.4 s of a 2.4 s call on its 134 prompt tokens at 17.6 ms each). Adding ~280 tokens to a 1.5B call added 4.2 s; an
  identical prompt repeated is not cached. So: shorter prompts, and no call at all when the rules explained everything
  (the gate).
* **Generation is memory-bound:** 78 / 32 / 15 tokens/s for 0.5 / 1.5 / 3B, 11-14 for the 3-4B Phi and Ministral models. The
  grammar keeps outputs short (6-20 tokens), so generation is only about a tenth of a call.
* Grammar and JSON-schema constraining cost about the same; unconstrained is not cheaper and is not safer.

### 2.2 Accuracy by model (held-out split, correct transcript, hybrid strategy)

`synth-v1` held-out (63 cases), oracle transcript so that only the extraction stage is measured, default prompt (`v4`,
below). "LLM calls" = cases where the gate opened (52 of 63; the other 11 were fully explained by the rules). Suggestions
are always **needs review**; silent-wrong was **0 %** for every model.

| Config | Field acc | **Enum acc** | Id acc | Hallucination | Review | LLM right / wrong / said nothing | LLM call p50 / p95 | Resident |
|---|---|---|---|---|---|---|---|---|
| rules only | 81.7 % | 37.7 % | 100 % | 0 % | 3.9 % | - | - | - |
| + qwen2.5-0.5b | 85.0 % | 49.1 % | 100 % | 7.7 % | 26.0 % | 26 / 40 / 0 | 1.2 / 1.5 s | 0.8 GB |
| **+ qwen2.5-1.5b** | 93.4 % | 77.4 % | 100 % | 2.2 % | 22.4 % | 46 / 17 / 3 | 3.2 / 4.2 s | 1.7 GB |
| + qwen2.5-3b | **98.3 %** | **94.3 %** | 100 % | 1.1 % | 22.4 % | 62 / 3 / 1 | 6.2 / 7.7 s | 3.0 GB |
| + phi-3.5-mini | 97.0 % | 89.6 % | 100 % | 0.0 % | 20.5 % | 55 / 5 / 6 | 8.5 / 11.3 s | 3.6 GB |
| + ministral-3-3b | **98.3 %** | **94.3 %** | 100 % | 0.0 % | 21.3 % | 60 / 3 / 3 | 7.4 / 9.3 s | 4.4 GB |
| + phi-4-mini | **98.3 %** | **94.3 %** | 100 % | 0.0 % | 21.1 % | 60 / 2 / 4 | 7.2 / 9.1 s | 4.7 GB |

* **The rules handle the structure; the model handles the slang.** 24 enum fields are right from the rules alone, 66 are
  not (held-out phrasing is deliberately outside the lexicon: "did a change-out on the can", "was weeping badly").
* **Size is the lever:** enum accuracy 49 -> 77 -> 94 % from 0.5B to 1.5B to 3B. The **0.5B model's suggestions are wrong more
  often than right** (40 wrong to 26 right; 7.7 % hallucination, 26 % of fields to review): its accuracy gain over the rules
  is only that an empty field became a wrong one - the worker gets corrections to make, not help. Do not ship it.
* **Three 3-4B models tie at 94 %.** Qwen2.5-3B is the cheapest (6.2 s, 3.0 GB); Ministral-3-3B and Phi-4-mini add zero
  hallucination for ~1.5x the memory; Phi-3.5-mini is slower and a little worse. With only 63 cases the gaps between the
  three are 1-3 fields: treat them as a tie.
* **Review rate is the price:** about a fifth of all fields arrive as "AI suggestion - please confirm". Those are
  suggestions the worker would otherwise have typed; the safety property is that none is presented as settled.

### 2.3 The prompt mattered as much as the model

The first prompt told the model "use null for anything the statement does not say, never guess". Qwen2.5-1.5B obeyed: it
left **62 %** of the slang fields empty (`null` for 48 of 78 on the prompt-tuning set) and was right on
20. Forced to choose it was right on **80 %** (62 of 78): the knowledge was there, the abstention was the problem. Prompts
were compared on `prompt-dev` (hand-written, disjoint from the held-out phrases), then the winner was reported on held-out:

| Prompt (Qwen2.5-1.5B) | What it changes | prompt-dev enum acc | prompt-dev halluc. | Prompt tokens | LLM p50 | **Held-out** field / enum acc |
|---|---|---|---|---|---|---|
| v0 | original: codes only, "null ... never guess" | 54.0 % | 4.4 % | 111 | 1.3 s | 83.9 % / 45.3 % |
| v1 | "closest in meaning" instruction | 51.6 % | 6.4 % | 134 | 2.3 s | - |
| v2 | options with their labels | 50.8 % | 6.8 % | 159 | 3.5 s | - |
| v3 | labels + two synonyms each | 57.1 % | 3.2 % | 199 | 4.4 s | - |
| **v4** | enum fields as `{"mentioned": bool, "value": option}`, no `null` | 50.8 % | 14.5 % | 132 | 3.1 s | **93.4 % / 77.4 %** |

* Rewording (v1-v3) moves accuracy by a few points and triples latency. **Separating "was it mentioned?" from the value
  (v4)** is what unlocks the model: +9.5 points field accuracy and +32 points enum accuracy on held-out, for about +0.8 s.
* **v4's honest weakness:** it says "mentioned" too readily. On `prompt-dev` - where each statement mentions *one* of the
  enum fields the model is asked about - hallucination rises to 14.5 % and net accuracy does not improve. On held-out,
  where most asked fields are mentioned, it wins big. Real speech will be somewhere in between, which is one more reason
  every suggestion stays `needs review` and why the customer's own recordings should decide whether to keep v4 or fall back
  to the cautious v0 (`FV_PATCH_PROMPT=v0`).
* Qwen2.5-3B was insensitive to the wording too (prompt-dev enum 55.6 % -> 56.3 % with the v1 wording).

### 2.4 Three safeguards the models forced us to add

Found by running the pipeline over generated data (details in [DATASET.md](DATASET.md#what-the-data-found)):

* **Boolean topic gate.** A 0.5B model answered `customer_notified = true` for statements that never mention a customer.
  A boolean is now asked about only if the statement touches its topic.
* **Absence guard.** A 1.5B model answered "none / no issues" for fields nobody mentioned. A model may now claim "none" only
  when the statement says something negative or reassuring.
* **The LLM gate** treated words from *other* options' wording ("good", "fine") as known vocabulary, so "it checks out
  fine" never reached the model: 44 of 49 recoverable held-out cases reached it before, all 49 now.

## 3. End to end: real speech into the extraction pipeline

The held-out clips that have audio (36 of the 63), speech engine x model, hybrid strategy, default prompt. **Total** = end of
speech to the last suggestion (speech + rules + model); the rules-only result is on screen about a millisecond after the
transcript. Dev box, quiet.

| Speech | Model | Field acc | Id-field acc | Enum acc | Silent-wrong | Hallucination | Review | Speech p50 | Model p50 | **Total p50 / p95** | Resident |
|---|---|---|---|---|---|---|---|---|---|---|---|
| whisper-base | rules only | 76.1 % | 81.8 % | 40.0 % | 0 % | 0 % | 3.8 % | 1.4 s | - | 1.4 s | 0.4 GB |
| whisper-small | rules only | 77.0 % | 84.4 % | 40.0 % | 0 % | 0 % | 2.4 % | 3.5 s | - | 3.5 s | 0.8 GB |
| whisper-base | qwen2.5-1.5b | 85.2 % | 81.8 % | 71.7 % | 0 % | 1.9 % | 21.1 % | 1.2 s | 3.3 s | 4.4 / 5.2 s | 2.0 GB |
| whisper-base | qwen2.5-3b | 90.9 % | 81.8 % | 91.7 % | 0 % | 0 % | 22.0 % | 1.2 s | 6.7 s | 7.9 / 9.4 s | 3.3 GB |
| whisper-small | qwen2.5-1.5b | 85.2 % | 83.1 % | 70.0 % | 0 % | 1.9 % | 19.6 % | 3.6 s | 3.4 s | 6.8 / 8.0 s | 2.4 GB |
| whisper-small | qwen2.5-3b | 90.9 % | 83.1 % | 90.0 % | 0 % | 1.9 % | 22.0 % | 3.6 s | 7.4 s | 10.8 / 12.5 s | 3.7 GB |

The rules-only rows are re-scored with the final normalizer; the four hybrid rows ran before the hyphen fix, which affects one
of the 36 clips (for whisper-small it is worth 1.3 points of id accuracy, as the rules-only rows show).

* **The two stages are independent.** Speech decides the id-field accuracy (82-84 % here, the same for both models); the
  model decides the enum accuracy (70-72 % for 1.5B, 90-92 % for 3B). Field accuracy is capped by whichever is weaker.
* **A bigger speech model barely helps in this subset** (+2.6 points of id accuracy for ~2.5x the speech time); a bigger
  language model helps a lot (+19 points of enum accuracy for 2x the model time).
* **Silent-wrong stays 0 %** end to end: a misheard digit that lands outside the job's assets is flagged with the closest
  valid ids; one that lands on a valid neighbour is the residual risk the confirmation UI exists for.
* Total latency is dominated by the model stage once a model is used - which is why the product shows the rules result first.

## 4. Strategy ablation: what each layer buys

Held-out split, correct transcript (so only the extraction approach differs), the same cases for every row unless noted.
`free_json` is a **reconstruction** of the prototype's approach (one prompt with the whole form, free JSON) - the customer's
real prompt can replace it (`data/baseline_prompt.txt`). **Silent-wrong** = share of confident (not flagged) fields that are wrong.

| Strategy | Model | Cases | Field acc | Id-field acc | **Silent-wrong** | Hallucination | Model call p50 |
|---|---|---|---|---|---|---|---|
| `rules_only` | none | 63 | 81.7 % | 100 % | **0 %** | 0 % | - |
| `hybrid` (default) | qwen2.5-1.5b | 63 | 93.4 % | 100 % | **0 %** | 2.2 % | 3.2 s, 52 of 63 cases |
| `hybrid` (default) | qwen2.5-3b | 63 | 98.3 % | 100 % | **0 %** | 1.1 % | 6.2 s, 52 of 63 cases |
| `enum_grammar` (LLM only, tight grammar) | qwen2.5-0.5b | 63 | 46.3 % | 42.6 % | 65.1 % | 40.1 % | 6.0 s (shared CPU) |
| `enum_grammar` | qwen2.5-1.5b | 63 | 56.5 % | 38.8 % | 49.4 % | 35.7 % | 5.0 s, every case |
| `enum_grammar` | qwen2.5-3b | 63 | 52.6 % | 29.5 % | 50.0 % | 29.7 % | 8.5 s, every case |
| `enum_grammar` | ministral-3-3b | first 30 | 56.6 % | 31.7 % | 17.6 % | 3.4 % | 9.4 s, every case |
| `free_json` (prototype-style) | qwen2.5-3b | first 20 | 87.3 % | 83.7 % | **18.5 %** | 18.0 % | 12.4 s |
| `schema_constrained` | qwen2.5-3b | first 20 | 76.3 % | 76.7 % | 34.6 % | 36.1 % | 12.6 s |
| *same 20 cases:* `hybrid` | qwen2.5-3b | first 20 | 97.5 % | 100 % | 0 % | - | ~6 s |

* **Without the deterministic layer, ids are the casualty** (id-field accuracy 30-43 % for the tight-grammar LLM-only
  strategy: the model swaps which number is the pole and which the unit) and roughly **half of the confident fields are
  silently wrong** (Qwen; Ministral does better at 18 %). Making the model bigger does not fix it (1.5B -> 3B: 49 % -> 50 %).
* **Constraining the output guarantees shape, not truth:** JSON validity was 100 % on every row above; silent-wrong was
  not. `schema_constrained` was *worse* than `free_json` on this model.
* **The prototype-style call is the slow one:** a 240-token prompt and ~65 output tokens cost 12.4 s here (p50) - several
  times that on the tablet, which is the order of the ~45 s reported for the current prototype. The hybrid's model call is
  half that, happens on fewer cases, and arrives after the rules result.
* The gate ("only when words remain unexplained") on its own: `hybrid` asked the model on 52 of 63 held-out cases (slang by
  construction) but on only 19 of 177 dev cases - utterances the lexicon explains never reach it and cost nothing.

## 5. Sizing the tablet (estimates, not measurements)

What changes from this machine to a Latitude 7220 (4 cores, AVX2, LPDDR3-2133 ~ 34 GB/s peak, no NPU):

* **Prefill** (compute-bound, scales with prompt tokens x parameters): several times slower - plan on **4-6x**. A 1.5B call
  that takes 2.4-3.2 s here is in the **10-20 s** range there; a 3B call 20-35 s. This is why prompt length and the gate matter.
* **Generation** (bandwidth-bound): **2-3x** slower; a 2-3 GB model cannot exceed roughly 10-13 tokens/s on that memory.
* **Speech:** Whisper-base at RTF 0.14-0.24 here (two sessions) is plausibly RTF 0.6-1.5 there (an 8 s utterance in 5-12 s);
  tiny (0.09) is the fallback; small (0.45) and medium (1.16) are not realistic in batch mode. A **streaming** engine hides the
  wait only while it keeps up: Nemotron is at RTF 0.45 here (0.19 s tail) but would be at roughly 1.8-2.7 on a CPU 4-6x slower,
  and then the tail grows to about (RTF - 1) x the speech length - 7-14 s for an 8 s utterance, no better than batch
  Whisper-base. It needs a tablet test.
* **Memory:** base + a 1.5B model is about 2 GB resident (2.0 GB measured here), fine for 8 GB; a 3-4B model is 3-5 GB.

Design consequences already in the product: rules results appear immediately after speech; model suggestions arrive as a
second progressive update (the WebSocket sends `stage` / `fields` events as each stage finishes) so the worker is reviewing
the form while the model works; the model is *optional* (`rules_only` is the fallback when it is missing or too slow).

**Do this on the device first** (an hour): `scripts\bench_device.bat --stt foundry:stt:whisper-base:cpu --llm
foundry:llm:qwen2.5-1.5b:cpu` (a minute per engine) - it replaces this section with measurements - then
`scripts\run_eval.bat run ...` with `FV_DEVICE_PROFILE=latitude-7220`.

## 6. What would change these conclusions

* **Real speech.** Accents, hesitations, crosstalk and radio chatter will lower speech accuracy and raise the review rate.
  100-150 labelled recordings from the actual tablet microphone are enough to confirm or overturn the ranking
  ([EVALUATION.md](EVALUATION.md#6-replacing-synthetic-data-with-customer-data)).
* **The customer's real forms and vocabulary.** The lexicon is the cheapest accuracy lever there is: every phrase a subject
  matter expert adds is a field the model no longer has to guess. The lexicon, templates and rules were written by the same
  team, so synthetic rules-only numbers flatter the deterministic stage; the held-out split is the honest read.
* **Prompt calibration on real statements.** v4 vs v0 depends on how often the model is asked about fields nobody mentioned.
* **Role words without the noun.** "Old one 4193..., new one 5359..." has no role phrase the form knows ("old meter",
  "removed meter"), so the roles fall back to the order of mention and are flagged *role not stated*. If the first id is
  misheard the roles can swap: half of the ids Whisper-medium still gets wrong are this template. The cure is vocabulary
  (a subject-matter expert listing how crews really say it), not a bigger model - and it is deliberately not patched here,
  because these are the held-out phrasings.
* **Suggestions count for something.** An id the speech engine garbled but that is one edit from a job asset is shown flagged
  with the closest valid id ("not in today's assets; closest: 45204879"). The accuracy columns score the *value* only, so they
  understate what the worker sees: one tap fixes it. "Correct or one tap away" is the natural next metric. Not built.
* **A different mechanism for slang.** A small embedding model matching clauses to option phrases (no generation at all)
  is the obvious next experiment: it costs a fraction of a 3B call and has no way to hallucinate a value that is not an
  option. Not built.
* **No grammar-constrained decoding.** The prebuilt ONNX Runtime GenAI iOS build has none, and the default prompt was written
  around the grammar: without it Qwen2.5-1.5B and 3B fall from 93.4 / 98.3 % to 83.9 / 83.4 % field accuracy (silent-wrong
  still 0 %), and a flat prompt with tolerant option matching recovers 90.6 / 94.5 % (Phi-4-mini: 96.4 %, grammar 98.3 %). Details in
  [IOS_SPIKE.md](IOS_SPIKE.md#what-losing-the-grammar-costs); `python -m backend.evalkit.noguidance` reproduces it.
* **KV-cache reuse of a static prefix.** Would cut the prompt cost, but Foundry Local's grammar path is stateless
  (`docs/FINDINGS.md` #12). Worth a spike.

## Azure Speech: what is missing

The Azure embedded (offline) and cloud (accuracy-ceiling) engines are implemented behind the same interface and show up in
the Lab and the engine list, but **no Azure number appears here**: they need `FV_AZURE_SPEECH_KEY` /
`FV_AZURE_SPEECH_REGION` (cloud) or approved embedded model files (`FV_EMBEDDED_SPEECH_MODEL_PATH`, limited-access
registration), and `pip install -r backend/requirements-optional.txt`. With those set, `scripts\run_eval.bat engines` lists
them as ready and the same matrix runs unchanged. Azure's **phrase lists** (bias recognition toward the day's pole and unit
ids) are the one speech-side lever Foundry Local does not offer, and the likeliest way past the 95 % id gate - worth
testing first.

## Reproduce

The runs behind this document ship in [`results/`](../results/README.md) (an index maps each run to the section that quotes
it), and `scripts\load_sample_results.bat` copies them into `data/runs/` so they open on the app's Results page. To produce
them again yourself:
```bat
scripts\build_dataset.bat
.venv\Scripts\python.exe -m backend.synth.prompt_dev
scripts\bench_device.bat --stt foundry:stt:whisper-tiny:cpu --stt foundry:stt:whisper-base:cpu --stt foundry:stt:whisper-small:cpu --stt foundry:stt:whisper-medium:cpu --stt foundry:stt:nemotron-speech-streaming-en-0.6b:cpu --live
scripts\bench_device.bat --llm foundry:llm:qwen2.5-1.5b:cpu --repeats 5
scripts\run_eval.bat run --dataset synth-v1 --stt foundry:stt:whisper-tiny:cpu --stt foundry:stt:whisper-base:cpu --stt foundry:stt:whisper-small:cpu --stt foundry:stt:whisper-medium:cpu --stt foundry:stt:nemotron-speech-streaming-en-0.6b:cpu --strategy rules_only
scripts\run_eval.bat rescore <run_id>
scripts\run_eval.bat run --dataset synth-v1 --split heldout --strategy hybrid --llm foundry:llm:qwen2.5-1.5b:cpu --llm foundry:llm:qwen2.5-3b:cpu
scripts\run_eval.bat run --dataset synth-v1 --split heldout --strategy enum_grammar --llm foundry:llm:qwen2.5-1.5b:cpu
scripts\run_eval.bat run --dataset synth-v1 --split heldout --limit 20 --strategy free_json --strategy schema_constrained --llm foundry:llm:qwen2.5-3b:cpu
scripts\run_eval.bat run --dataset synth-v1 --split heldout --stt foundry:stt:whisper-base:cpu --llm foundry:llm:qwen2.5-1.5b:cpu --strategy hybrid
set "FV_PATCH_PROMPT=v0" && scripts\run_eval.bat run --dataset prompt-dev --strategy hybrid --llm foundry:llm:qwen2.5-1.5b:cpu
.venv\Scripts\python.exe -m backend.evalkit.noguidance run --dataset synth-v1 --split heldout --strategy hybrid --llm foundry:llm:qwen2.5-1.5b:cpu
set "FV_PATCH_PROMPT=v3" && .venv\Scripts\python.exe -m backend.evalkit.noguidance run --dataset synth-v1 --split heldout --strategy hybrid --llm foundry:llm:qwen2.5-3b:cpu --tolerant-enums
```

Stored runs referenced above (`data/runs/`; copies in `results/runs/`): speech sweeps `20261030-190732-9d6a37` (tiny / base / small) and
`20261030-231428-4524dd` (Nemotron, medium), as measured, and re-scored with the final normalizer (the numbers in section 1):
`20261030-234629-8fc068` and `20261030-234636-93ea73`; held-out ladder `20261030-214332-b49d27`
(rules only), `-214333-830469` (0.5B), `-214450-f2b78f` (1.5B), `-214754-c9c554` (3B), `-215342-6dbb1e` (Phi-3.5-mini),
`-220133-55b66d` (Ministral-3-3B), `-220829-fc39e2` (Phi-4-mini); end to end `20261030-221648-364615` (rules; re-scored
`-235232-76aef4`), `-222002-79be0f` (hybrid, run before the hyphen fix: one of its 36 clips is affected); LLM-only
`-223427-7f50ba` (1.5B), `-223953-f8f75e` (3B), `-224911-717c4f` (Ministral, 30 cases), `-225422-36102f` (free JSON / schema,
20 cases), `20261030-192045-d88b89` (0.5B, earlier, shared CPU); prompt comparisons labelled `pv-*` and
`heldout-qwen2.5-1.5b-v0/v4`; grammar blocked (the iOS-build behavior, `ios-noguidance-*`) `20261106-181358-0657e7` (1.5B),
`-181958-589d59` (3B), `-191258-dcef9b` (1.5B, flat prompt), `-184221-356a43` (3B, flat prompt), `-185813-81651b` (Phi-4-mini,
flat prompt). Device probes: `data/bench/stt-all.json` (speech, live), `data/bench/llm-*.json` (copies in
`results/bench/`).
