# iOS and iPad: what is verified, what is not, and the spike that settles it

About 80 % of the customer's future fleet is iOS, iPads included. **Foundry Local does not run on iOS** (it targets Windows,
macOS and Linux), so the Windows demo does not carry over by itself. **The models can**: Foundry Local serves ONNX models
through ONNX Runtime GenAI, and that engine publishes iOS builds. The customer call settled the model choice -
**Whisper-base for speech-to-text, Qwen2.5 or Phi-4-mini for the language model** - so this page checks that combination.
Everything here was checked on 6 Nov 2026. **Nothing has been run on an iPad** (no Mac or iPad was available), so every
device number - speed, memory, heat - is still to be measured by the spike below.

Evidence labels: ✅ read from a primary source · 🔬 inspected in the shipped file or binary (static analysis - not run on
iOS) · 📊 measured on the Windows dev box, not on iOS (the grammar tests reproduce the iOS build's behavior) · 🟡 secondary
source - verify before relying on it · ❓ not checked.

## Bottom line

| Question | Answer |
|---|---|
| Can Whisper-base and Qwen2.5 / Phi-4-mini run on an iPad? | **Probably - build and measure, not turnkey.** ONNX Runtime GenAI ships prebuilt iOS binaries and a .NET MAUI NuGet that carry every operator these models need. There is no official Whisper-on-iOS or iPad sample, and nobody has run our exact models there. |
| What do they run on? | The **CPU** (ARM, NEON). The Neural Engine and GPU stay idle: Core ML cannot run these models' operators. |
| What is missing from the prebuilt build? | **Grammar-constrained decoding.** It stays safe (silent-wrong 0 %, ids 100 %), but with the current prompt Qwen2.5-1.5B drops from 93.4 % to 83.9 % field accuracy. A prompt written for no grammar recovers most of it: 90.6 / 94.5 / 96.4 % for Qwen2.5-1.5B / 3B / Phi-4-mini against 93.4 / 98.3 / 98.3 % with grammar (see "What losing the grammar costs"). |
| What decides which model fits? | **RAM**: about 2.0 / 3.3 / 5.0 GB resident for Whisper-base + Qwen2.5-1.5B / Qwen2.5-3B / Phi-4-mini on Windows; iPads have 4-16 GB and Apple publishes no per-app limit. |
| What should happen first? | Run the prebuilt artifacts on the customer's smallest and newest iPad (spike step 1), port the deterministic core once to C# against the golden vectors, and keep the model behind an interface with **rules only** as the fallback. |

## What we know

| Fact | Evidence |
|---|---|
| ONNX Runtime **GenAI** (the engine inside Foundry Local, Windows ML and the VS Code AI Toolkit) **ships prebuilt iOS binaries**: `onnxruntime-genai-ios-<version>.zip` on GitHub releases since v0.6.0 (Feb 2025), latest v0.19.0 (4 Nov 2026, 55.6 MB) - an xcframework with `ios-arm64` (iPhone and iPad), simulator and Mac Catalyst slices plus the C/C++ headers, and C / Objective-C pod archives. The README's "iOS on the roadmap" line is **stale**. The GenAI pods are not on CocoaPods trunk; ONNX Runtime's own `onnxruntime-c` and `onnxruntime-objc` pods are (1.30.0). | ✅ [GitHub releases](https://github.com/microsoft/onnxruntime-genai/releases) and release assets · trunk.cocoapods.org |
| The **`Microsoft.ML.OnnxRuntimeGenAI` 0.19.0 NuGet** has first-class .NET targets `net9.0-ios15.4`, `net9.0-maccatalyst14.0` and `net9.0-android31.0` and bundles `runtimes/ios/native/onnxruntime-genai.xcframework.zip`. That zip is **byte-identical** to the GitHub release zip (SHA-256 `7081273f…`), so numbers measured with the native spike kit transfer to a .NET MAUI app. The managed assembly for `net9.0-ios15.4` exposes the Whisper path (`Audios`, `MultiModalProcessor.ProcessAudios`, `SetInputs`) and `SetGuidance` (type and member names found in the assembly; not executed). It depends on `Microsoft.ML.OnnxRuntime` 1.31.0 and needs .NET 9 - confirm the customer's MAUI version. | 🔬 package contents, hashes and assembly metadata |
| Minimum OS: GenAI xcframework **iOS 13.0**; ONNX Runtime 1.30.0 iOS pod **iOS 15.1**. Both are below the customer's iOS 16 floor. iPhone and iPad use the same `ios-arm64` device slice. | 🔬 Mach-O load commands · podspec |
| The ONNX Runtime iOS device binary contains **every operator our Foundry models use**: `MatMulNBits`, `GroupQueryAttention`, `SkipSimplifiedLayerNormalization`, `MultiHeadAttention`, `GatherBlockQuantized` and, for Whisper, `DynamicTimeWarping`, `UnfoldTensor` and `BeamSearch`. The GenAI iOS binary contains the Whisper pipeline (`WhisperModel`, log-mel features, audio decoding) and the Qwen2 and Phi-3 model types (Phi-4-mini is `type=phi3`). Strings in the binary, not a run; checked on ONNX Runtime 1.30.0 while the NuGet pairs 1.31.0. | 🔬 binary scan and the ONNX graphs of our models |
| **Constrained decoding is not in the shipped iOS build.** Guidance (llguidance) is a compile-time option, off by default; the iOS device binary contains none of the llguidance strings that the Windows build (the positive control) does. A grammar or JSON-schema request throws `Guidance is unavailable in this build ... Rebuild with use_guidance=true.` - it never silently falls back. `build.py` has an iOS-aware `--use_guidance` path (needs a Mac, Xcode and Rust); not verified on a device. Our pipeline uses grammar for enum fields: see "What losing the grammar costs". | 🔬 binary scan with control · ✅ source (`constrained_logits_processor.cpp`, `build.py`) |
| **An iPad runs these models on the CPU.** Our model files are CPU-provider variants, and the Core ML provider (Neural Engine and GPU) documents `ai.onnx` operators only; the quantized matmul and attention above are `com.microsoft` contrib operators. The Neural Engine and GPU stay idle, so speed rests on the ARM NEON kernels - **not measured**. | ✅ [Core ML provider operator lists](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html) · 🔬 our model graphs |
| The **official iOS sample** is `LocalLLM` (note the doubled folder): Phi-3-mini-128k int4, Objective-C++ over the GenAI C++ API, with per-token timing. Prerequisites: macOS 14+, Xcode 15+, iOS SDK 16+ (iPhone 14/15, A16/A17 preferred); it builds ONNX Runtime and GenAI from source and bundles old ONNX Runtime 1.19 libraries. **There is no Whisper iOS sample and no iPad mention** - ONNX Runtime's Whisper examples are Android only, and its only iOS speech example is wav2vec2 (`mobile/examples/speech_recognition/ios`), not Whisper. | ✅ [LocalLLM README](https://github.com/microsoft/onnxruntime-inference-examples/blob/main/mobile/examples/phi-3/ios/LocalLLM/LocalLLM/README.md) |
| An open issue reports **memory growth on iOS** when appending token sequences with ORT GenAI (v0.7.0 / v0.8.2; same code fine on Android; label `platform:mobile`). Still open on 6 Nov 2026 and **not re-tested on 0.19.0** - the spike must measure it. | ✅ [onnxruntime-genai #1540](https://github.com/microsoft/onnxruntime-genai/issues/1540) |
| ONNX Runtime **core** has official iOS packages (CocoaPods `onnxruntime-c` / `onnxruntime-objc`, Swift Package Manager `onnxruntime-swift-package-manager`). Any model that runs on core ORT (for example an ONNX Whisper graph) is therefore an iOS candidate without GenAI. | ✅ trunk.cocoapods.org · 🟡 [onnxruntime-swift-package-manager](https://github.com/microsoft/onnxruntime-swift-package-manager) |
| Apple's **Foundation Models** framework (iOS 26+) gives an on-device ~3 B model with *guided generation* (`@Generable`) and no model distribution - but only on Apple-Intelligence-capable hardware (iPhone 15 Pro and later, M-series iPads, iPad mini with A17 Pro; **not** the base iPad, 10th generation, A14). It is a different model from Qwen or Phi, so it would need its own evaluation. | ✅ [Apple iPad comparison](https://www.apple.com/ipad/compare/) · 🟡 [Foundation Models docs](https://developer.apple.com/documentation/foundationmodels) |
| Apple's **SpeechAnalyzer / SpeechTranscriber** (iOS / iPadOS 26+) is a new on-device, long-form recognizer; the older `SFSpeechRecognizer` supports on-device mode (`requiresOnDeviceRecognition`) with shorter sessions. The customer's iOS app uses `SFSpeechRecognizer` today. | 🟡 [SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer) |
| Azure *embedded* speech: Windows 11+ in the docs, access is gated, **no iOS**. Azure cloud speech obviously needs a connection. | ✅ earlier research, see [FINDINGS.md](FINDINGS.md) (row 8) |
| Alternatives checked at the source level (not run): **WhisperKit** (`argmaxinc/argmax-oss-swift`) - Core ML Whisper including `base`, iOS 16+ (Core ML can use the Neural Engine); **sherpa-onnx** (`k2-fsa`) - iOS xcframework (min iOS 13, v2.0.1), a Swift API with a Whisper config and SwiftUI examples, on its own ONNX exports and decode loop; **MLX Swift** (`ml-explore/mlx-swift-examples`) - registry has Qwen2.5-1.5B and Qwen3 (Phi-4-mini support not verified); **llama.cpp** - iOS SwiftUI example and XCFramework scripts (grammar support ❓ not checked here). Each uses different model files from Foundry's, so each has to be re-evaluated, not assumed equal. | ✅ repositories and package manifests |

## What losing the grammar costs

📊 Measured on the Windows engines with the iOS build's behavior reproduced. The prebuilt iOS build cannot constrain output,
and our default prompt (`v4`) was written for a grammar: it asks each enum
field as `{"mentioned": true|false, "value": <option>}`, a shape the grammar enforces. `python -m
backend.evalkit.noguidance` reproduces the iOS build on the Windows engines - every grammar or schema request fails with the
build's own error, so the pipeline's fallback chain (grammar → schema → none) ends up unconstrained. Same 63 held-out cases,
correct transcript, `hybrid` strategy, same model files and greedy decoding; what this does not exercise is the iPad's CPU
and its kernels. Runs: [results/README.md](../results/README.md).

| Configuration | Field acc | Enum acc | Id acc | Silent-wrong | Model right / wrong / said nothing |
|---|---|---|---|---|---|
| Qwen2.5-1.5B, with grammar (the Windows result) | 93.4 % | 77.4 % | 100 % | 0 % | 46 / 17 / 3 |
| Qwen2.5-1.5B, **no grammar**, default prompt | 83.9 % | 45.3 % | 100 % | 0 % | 12 / 5 / 49 |
| Qwen2.5-1.5B, no grammar, flat prompt `v3` + tolerant matching | 90.6 % | 67.9 % | 100 % | 0 % | 38 / 18 / 10 |
| Qwen2.5-3B, with grammar | 98.3 % | 94.3 % | 100 % | 0 % | 62 / 3 / 1 |
| Qwen2.5-3B, **no grammar**, default prompt | 83.4 % | 43.4 % | 100 % | 0 % | 6 / 0 / 60 |
| Qwen2.5-3B, no grammar, flat prompt `v3` + tolerant matching | 94.5 % | 81.1 % | 100 % | 0 % | 46 / 3 / 17 |
| Phi-4-mini, with grammar | 98.3 % | 94.3 % | 100 % | 0 % | 60 / 2 / 4 |
| Phi-4-mini, no grammar, flat prompt `v3` + tolerant matching | 96.4 % | 87.7 % | 100 % | 0 % | 57 / 6 / 3 |
| Rules only (no model) | 81.7 % | 37.7 % | 100 % | 0 % | - |

* **Safety survives.** Silent-wrong stays 0 % and ids stay 100 % in every run: the rules and the job's closed world do not
  need the grammar, and a model answer that is not a valid option is dropped, not shown.
* **Helpfulness does not.** With the default prompt the model "says nothing" for 49 (1.5B) and 60 (3B) of the 66 enum fields
  the rules cannot fill. The 1.5B's logged replies show why: JSON of the wrong shape (for example `"work_performed":
  "true"` - it reads *mentioned true|false* as the answer), which the pipeline rightly drops. Both models land within about
  2 points of rules only, and the bigger model does not fix it: the prompt was designed around the grammar.
* **A prompt written for no grammar recovers most of it, not all.** `v3` lists every option with its label and synonyms as a
  flat field, and `--tolerant-enums` accepts an option named by its label or in another case (18 of the 1.5B's 84 enum
  answers were labels such as "Failed meter" rather than codes). Field accuracy goes from 83.9 to 90.6 % (1.5B, grammar:
  93.4 %) and from 83.4 to 94.5 % (3B, grammar: 98.3 %). Phi-4-mini, tried only with this prompt, reaches 96.4 % (grammar:
  98.3 %) and is the least affected, though it gives 6 wrong model answers instead of 2 and 2.2 % hallucination instead of
  0 %. The Qwen models also "say nothing" more often than with a grammar (10 against 3 fields for the 1.5B, 17 against 1 for
  the 3B). The price is a longer prompt (207 against 137 tokens on average for the 1.5B), which on a CPU is mostly prefill -
  re-measure speed on the iPad.
* The grammar runs came from a quiet machine and the no-grammar runs from a shared one, so **latencies are not comparable**
  and are not quoted; accuracy is unaffected.

## iPad memory: what the models need against what iPads have

Apple publishes no per-app memory limit (the `com.apple.developer.kernel.increased-memory-limit` entitlement, iPadOS 15+,
"is only available on some device models"), so this says what is **needed**, not what fits. Measure each iPad class with
`os_proc_available_memory()`.

| Model pair (CPU int4, the Foundry files) | Files on disk | Resident on Windows 📊 |
|---|---|---|
| Whisper-base + Qwen2.5-1.5B | 0.2 + 1.8 GB | 2.0 GB |
| Whisper-base + Qwen2.5-3B | 0.2 + 3.0 GB | 3.3 GB |
| Whisper-base + Phi-4-mini | 0.2 + 4.3-5.3 GB (catalog variants) | ≈ 5.0 GB (4.7 GB model + 0.3 GB Whisper) |

iPad memory spans roughly **4 GB to 16 GB**. [Apple's iPad comparison](https://www.apple.com/ipad/compare/) ✅ lists 8, 12 and
16 GB of unified memory on the M-series iPads (8 GB for the iPad Air M2; 16 GB for iPad Pro models with 1-2 TB of
storage); a third-party review puts the 10th-generation base iPad (A14, not an Apple-Intelligence device) at 4 GB 🟡. The
fleet's actual models decide everything below.

* A 4 GB iPad cannot be assumed to hold even Whisper-base + Qwen2.5-1.5B (2.0 GB resident) once the app and the OS are counted.
* Phi-4-mini's ~5 GB is a question for the 16 GB iPad Pro, not for an 8 GB iPad.
* Where no model fits, **rules only** is the fallback: on the held-out split it reaches 81.7 % field accuracy, 100 % id
  accuracy and 0 % silent-wrong with no model at all ([RESULTS.md](RESULTS.md) section 2.2).

## What ports and what does not

| Layer | iOS plan |
|---|---|
| **Contracts** (`backend/schemas`, REST/WS shapes, sync protocol) | Language-neutral JSON; reuse as-is. |
| **Deterministic core** (normalize → resolve → validate, form lexicon, prompts, grammars) | **Port once, to C#**: the customer's app is .NET MAUI, so one port then serves Windows and iPad (Swift only if the iOS client goes native). It is dependency-free pure logic. `ios-spike/golden/golden_vectors.json` (generated by `python -m backend.evalkit.golden_vectors`, drift-checked by a test) is the language-neutral conformance suite: normalizer tokens and offsets, rules-only field results with statuses, the real LLM prompts and grammars. |
| **LLM runner** | Interface (`LlmRunner`) with interchangeable backends: Foundry Local on Windows, **ORT GenAI's prebuilt iOS build (no grammar)** on the iPad, and Apple Foundation Models / MLX / llama.cpp as alternatives. The pipeline only needs "prompt + optional grammar → JSON text", and it already falls back from grammar to schema to none. |
| **STT runner** | Interface (`SpeechRunner`): **Whisper-base through the same GenAI build** (`type=whisper`, the ~205 MB int8 model Foundry caches; the header's `OgaAudios::Load` takes audio files or in-memory audio), with WhisperKit (Core ML) and Apple's on-device recognizers as comparators. |
| **Store + sync** | Reimplement against SQLite/Core Data with `URLSession`; the protocol (bundle hash, idempotent completions, `base_version` conflicts, outbox) is the contract in [SYSTEMS.md](SYSTEMS.md). Background sync needs iOS background tasks. |
| **UI** | Native SwiftUI, or the existing React app inside a `WKWebView` with the REST/WS transport replaced by a native bridge. Decide after the model spike; do not start here. |

## The spike (time-boxed; sized to the team, not guessed here)

**Inputs needed first:** the real iPad models in the fleet (chip and RAM decide everything; a 4 GB iPad behaves nothing like
a 16 GB one), iPadOS versions, whether devices are MDM-managed, whether Apple-Intelligence-class devices are in scope, the
MAUI .NET version (the NuGet's iOS target is .NET 9), how 2-6 GB of model files reach the devices (❓ not researched), and
a Mac with Xcode - none was available here.

1. **LLM feasibility** - take the prebuilt iOS xcframework (GitHub release zip or the NuGet; no source build) and run the
   `ios-spike` benchmark on the oldest and newest iPad with the customer's candidates: **Qwen2.5-1.5B / 3B and Phi-4-mini**
   (the CPU ONNX files Foundry Local caches on Windows). Record load time, TTFT, tokens/s, peak footprint
   (`os_proc_available_memory`), thermal state across 30 minutes of repeated runs, and whether #1540-style memory growth
   appears - **without grammar** (the app template passes `useGrammar: false`) and with the flat `v3` prompts
   ([ios-spike/README.md](../ios-spike/README.md) step 3), then optionally on a custom `--use_guidance` build. Optionally
   repeat with Apple Foundation Models and an MLX / llama.cpp model for comparison.
2. **STT feasibility** - Whisper-base through the same GenAI build (no iOS Whisper sample exists, so budget for the audio
   path) against Apple's on-device recognizer (and SpeechAnalyzer on iPadOS 26), on the synthetic audio *and* a handful of
   real recordings from the customer's environment.
3. **Core port** - implement the normalizer and the resolver in C# (or Swift) against the golden vectors until every
   vector passes.
4. **End to end on device** - the work-order flow with the synthetic dataset subset; compare accuracy with the Windows run
   using identical metrics.

**Suggested decision gates** (agree them with the customer; these are starting points, not requirements):

| Gate | Starting value |
|---|---|
| p95 end-of-speech → proposed fields, on the **oldest** device | ≤ 5 s |
| Peak footprint while the app is foregrounded | well under the device's jetsam limit, no kill in a 30-minute loop |
| Thermal state during 10 consecutive extractions | never `serious`/`critical` |
| Field and enum accuracy **without grammar** vs the Windows run with grammar on the same cases | within an agreed margin (the no-grammar reproduction above is the floor to beat) |
| Silent-wrong rate | ≤ the Windows configuration |

**Outputs:** a `results-*.json` per run (schema `fieldvoice.ios-bench.v1`, written by the harness) summarized with the same
metric code as the Windows runs:

```bat
.venv\Scripts\python.exe -m backend.evalkit.ios_results results-llm-*.json results-stt-*.json --dataset synth-v1 --max-p95-ms 5000
```

It flags debug builds, low-power mode and thermal throttling, and scores speech with `wer_normalized` / `id_exact_match`.

## What is in `ios-spike/`

```
ios-spike/
  Package.swift                       SwiftPM library "SpikeKit" + tests
  Sources/SpikeKit/                   JSONValue, GoldenVectors, Results (schema), MemoryProbe (phys_footprint + peak sampler),
                                      Runners (LlmRunner / SpeechRunner protocols), LlmBench, SpeechBench, AppleSpeechRunner
  Tests/SpikeKitTests/                decodes the golden vectors; checks the results schema
  AppTemplate/                        SwiftUI harness + Objective-C++ ORT GenAI runner to drop into an Xcode app target
  golden/golden_vectors.json          conformance vectors (generated; the Python test suite fails if they drift)
```

> **None of the Swift / Objective-C++ code has been compiled or run** - there was no Mac in the environment that produced
> it. The C++ calls in `OrtGenAIRunner.mm` were checked by reading them against the v0.19.0 `ort_genai.h` from the prebuilt
> xcframework (every call and signature exists; `GetNextTokens()` has both the C++17 and C++20 forms), and they follow the
> official `LocalLLM` sample; header and library must come from the same zip. Treat it as a head start, expect to fix
> compile errors, and do not quote any number from it until it has run on a device.
> The Python side (`golden_vectors`, `ios_results`) *is* tested.
>
> The kit is native Swift / Objective-C++ on purpose: it measures the model runtime without MAUI in the way, and because the
> NuGet's xcframework is byte-identical to the one the kit links, the numbers carry over to the customer's MAUI app.

## Risks to watch

* GenAI ships prebuilt iOS binaries but has **no support statement for iOS** (its README still says roadmap), no official
  Whisper or iPad sample, and a memory-growth issue open since 0.7.0. Pin the xcframework, its headers and ONNX Runtime to
  one version. Mitigation: keep the `LlmRunner` seam so a different backend can replace it.
* **Memory is the first gate.** Model weights + KV cache + the app on a 4-8 GB iPad; jetsam kills are silent. Apple publishes
  no per-app limit; the `com.apple.developer.kernel.increased-memory-limit` entitlement (iPadOS 15+) raises it on some
  models only, and `os_proc_available_memory()` is how to read what the app actually has. Test on the smallest iPad first.
* Sustained load throttles phones and tablets; single-run benchmarks flatter them (the harness records thermal state).
* Apple Foundation Models and SpeechAnalyzer are attractive (no model distribution) but gate on OS version and hardware;
  they would split the product into "Apple-Intelligence devices" and "everything else".
* **Constrained decoding is missing from the prebuilt iOS build** (verified). The pipeline falls back from grammar to schema
  to none and every model suggestion stays *needs review*, so it stays safe - but enum accuracy drops sharply (next
  section). Test the mitigations there before choosing a model.
* **Model licenses.** Redistributing Foundry's model files inside an iOS app is a legal question that was not researched;
  the catalog and the Hugging Face model card disagree for Qwen2.5-3B (`qwen-research`) - see the README license table.
