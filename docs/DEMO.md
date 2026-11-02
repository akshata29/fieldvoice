# Demo script (about 12 minutes)

Audience: field-operations leads and IT. Goal: show the whole day - morning prep, working with no signal, sync - and
then show how the engine choice is made on evidence. This page is the presenter's cheat sheet; the narrative version with
screenshots, business context and the technical detail behind every step is [WALKTHROUGH.md](WALKTHROUGH.md).

**Before you start** (everything on screen is synthetic - see [DATASET.md](DATASET.md))

```bat
scripts\setup_backend.bat
scripts\build_dataset.bat            :: synthetic dataset with speech + the 11 scripted demo lines (demo-script)
scripts\run_demo.bat                 :: http://127.0.0.1:8010  (builds the UI the first time)
```

Optional but recommended: run the morning flow once beforehand (it downloads the models listed in the work package into
`data\models`), and load the stored evaluation runs (`scripts\load_sample_results.bat`) so the Results page has something to
show. To start a clean take: **Sync → Dispatcher console → Reset system of record**, ticking *Also wipe this device* (signs the
worker out and removes the downloaded work, drafts and outbox; models stay).

## 1. Morning, connected (3 min)

1. **Morning** → pick **Alex Rivera**, PIN **1234**, *Sign in*.
2. *Start my day*. Narrate the five live steps: session → work package downloaded and hash-verified → forms compiled and
   knowledge base indexed → **models present on the device** (downloaded if needed; this is the only time the network is
   used for AI) → offline-readiness self-test (a golden utterance is extracted end to end).
3. The result is a single answer: **Offline ready** (or *Ready, warnings*: the self-test also checks that the language-model
   stage fits a 5 s latency budget, and on a busy or slow machine it can come back amber - still usable, and the warning says
   why). Point out that the readiness check fails closed (missing model, expired package, unwritable disk) instead of
   letting the worker discover it in a substation.

## 2. Day, disconnected (5 min)

1. Flip the **airplane-mode switch** (header). Everything below needs no network - say so, then prove it: the banner reads
   *Offline - working from local data*.
2. Open the headline job **Replace leaking transformer at pole 123** (WO-10231). Note the closed world on the left: *this
   job's* poles, the old transformer **T9921**, and the truck's stock units - that list is what makes digit errors catchable.
3. Press **Start recording** and say the sentence from the call - or pick **demo-01** in *Play sample* (it is that sentence,
   word for word, spoken by a synthetic voice):
   *"I replaced the transformer at pole 123. The old unit was leaking oil and I installed unit 456."*
   Watch the form fill progressively; hover a field to see the **evidence** highlighted in the transcript; open **Why** to see
   how a value was decided. Point at the latency waterfall: speech-to-text dominates, extraction is milliseconds - the LLM was
   **not even called** because every word was explained. The removed unit (T9921) is marked *Prefill*: dispatch already knew it.
4. Play **demo-04** (*"…did a change-out on the can… the old unit was weeping badly…"*). The rules cannot explain "can" or
   "weeping", so the small local model is asked about **only** the unresolved fields, and its answers arrive marked **needs
   review** - never as a settled fact. The default 1.5B model can get one wrong (on our box it answers *Physical damage* for
   "weeping"): that is the point - a wrong suggestion is amber, visible and one tap to correct, and pressing *Approve* with
   suggestions still unconfirmed opens a "Some values still need review" dialog first. Open **Engines** (above the record
   button), choose **qwen2.5-3b** as the language model (loads in about 10 s), collapse the panel and play the line again:
   both fields come back right. That trade (accuracy vs seconds vs memory) is what [RESULTS.md](RESULTS.md) measures.
   (Or say your own slang.)
5. Play **demo-03** (*"pole one three two, sorry, one two three"*): the last id wins and the neighbouring pole is a real asset, so
   only the closed world and the correction logic keep it right. Say a wrong id on purpose (*"pole one two four"*, or paste it
   into *Type a transcript*): it is **not in today's assets**, so it is flagged with the closest valid ids instead of being
   silently accepted. **demo-11** is the headline sentence with a truck engine idling behind it - same words, different audio.
   **demo-06** never says the replacement unit. Later speech *adds* to the form (and never overwrites what the worker typed),
   so on a form that earlier takes already filled nothing is missing; to show the required-field guard, clear the
   *Replacement unit* box by hand - the badge turns red ("1 required field missing") and *Approve & save locally* greys out
   with the reason - or play demo-06 in the Lab, where every comparison starts from an empty form.
6. Say the headline sentence once more if you cleared a field, then **Approve & save locally**: the form locks and is queued
   for sync. Search the knowledge base (*"oil leak containment"*) - offline.

## 3. Back online (3 min)

1. **Sync**: the outbox shows the pending completion. The **dispatcher console** is the remote world - bump the work order's
   version *before* syncing to simulate a dispatcher edit while the worker was offline, press *Go online* and *Sync now*:
   you get a **conflict**, not an overwrite. *Resolve* offers *Keep mine* or *Take theirs*; *Keep mine* rebases the
   completion onto the new version and puts it back in the outbox as *Pending* - press *Sync now* once more to send it.
2. Approve a second job (WO-10235 and **demo-09** work well), then in the dispatcher console set *Drop response next* to 1 and
   press *Apply faults*. *Sync now*: dispatch commits the completion but the reply is lost, so the device shows **Failed** (it
   cannot know). *Sync now* again: the retry reuses the same operation id, dispatch recognises it, and the completion is
   applied **exactly once** - "Received at dispatch" counts one per job, not two.

## 4. Choosing the engines (2+ min)

1. **Models**: the Foundry Local catalog on this machine - sizes, what is downloaded, load/unload.
2. **Lab**: pick **demo-04** (the slang line) and the *Baseline vs hybrid* preset, or *Whisper sizes* for speech - fields,
   which ones are correct vs ground truth, latency waterfall, tokens. (Lab scores against the line's ground truth; what
   dispatch pre-filled counts as correct.)
3. **Results**: a stored evaluation run - e.g. the held-out ladder `ladder-heldout-*` or the Whisper sweep: metrics table,
   **Pareto** (latency vs accuracy, silent-wrong as the colour), the **decision** view with gates the customer can edit
   live, per-tag breakdown (digits, corrections, negation, noise), failures. State plainly that this dataset is
   **synthetic** and that the same screen will be run on the real tablets with the customer's recordings. The numbers and
   what they mean: [RESULTS.md](RESULTS.md).

## Things worth saying out loud

* **Silent-wrong rate** (a confident field that is wrong) is the metric that matters - JSON validity and raw accuracy hide it.
  Without the deterministic layer, an LLM-only extraction was silently wrong on 18-65 % of its confident fields depending on
  the strategy and model (about half for a tight grammar on Qwen); the hybrid on none ([RESULTS.md](RESULTS.md) section 4).
* A generative model asked to do everything is slow (the current prototype is reported at ~45 s per extraction). Rules plus a
  closed world answer most of it deterministically; the hybrid asks the model only about what remains, with a short prompt
  (a call costs its prompt tokens).
* Numbers shown on this machine are **not** the target hardware's, and timings in a live demo move with whatever else the
  laptop is doing. Demo the *behaviour*, run the *benchmark* on the device.
* iOS is a separate, honest question: see [IOS_SPIKE.md](IOS_SPIKE.md).
