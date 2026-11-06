# ios-spike

Starting kit for the iOS feasibility spike described in [docs/IOS_SPIKE.md](../docs/IOS_SPIKE.md).

> **Not compiled or run** - written without access to a Mac/Xcode. The Python tooling that consumes its output is tested.
> The C++ calls in `AppTemplate/OrtGenAIRunner.mm` were checked by reading them against the v0.19.0 `ort_genai.h` (every
> call and signature exists); that is not a compile.

## Contents

| Path | Purpose |
|---|---|
| `golden/golden_vectors.json` | Language-neutral vectors from the Python implementation: normalizer tokens/offsets, rules-only field results, real LLM prompts + grammars. Regenerate: `python -m backend.evalkit.golden_vectors` (a Python test fails if the file is stale). |
| `Package.swift`, `Sources/SpikeKit` | Swift package: golden-vector decoding, the results schema, memory probe, benchmark loops, runner protocols, Apple on-device speech runner. |
| `Tests/SpikeKitTests` | Decodes the vectors and checks the results schema (`swift test` on a Mac). |
| `AppTemplate/` | `BenchApp.swift` (SwiftUI harness), `OrtGenAIRunner.{h,mm}` (Objective-C++ over the ORT GenAI C++ API) and its Swift adapter. Add to an Xcode iOS app target. |

## Steps

1. **Use the prebuilt ONNX Runtime GenAI iOS framework - no source build is needed** (verified 6 Nov 2026, evidence in
   [docs/IOS_SPIKE.md](../docs/IOS_SPIKE.md)). Download `onnxruntime-genai-ios-<version>.zip` from the
   [onnxruntime-genai releases](https://github.com/microsoft/onnxruntime-genai/releases) (an xcframework with device,
   simulator and Mac Catalyst slices; `ort_genai.h` / `ort_genai_c.h` are inside it), or take the same binary from the
   `Microsoft.ML.OnnxRuntimeGenAI` NuGet package (`net9.0-ios15.4`) in a .NET MAUI app. It needs an ONNX Runtime iOS
   framework of the matching release next to it (the NuGet pulls it in). Use the headers from the same zip.
   **That build has no constrained decoding:** asking for a Lark grammar or JSON schema throws, so the app template runs the
   LLM benchmark with `useGrammar: false`; a grammar run is a separate experiment on a custom build (`build.py
   --use_guidance`, needs a Mac and Rust).
2. Create an iOS App target in Xcode; add this package (`SpikeKit`) and the files in `AppTemplate/`. In the bridging header
   add `#import "OrtGenAIRunner.h"`. In *Info.plist* set `NSSpeechRecognitionUsageDescription`,
   `UIFileSharingEnabled = YES` and `LSSupportsOpeningDocumentsInPlace = YES`.
3. Copy to the app's **Documents** (Finder → device → Files, or Xcode → Devices): `golden_vectors.json`; ONNX GenAI model
   folders under `models/<name>/` (each with `genai_config.json`; the CPU variants Foundry Local caches on Windows are standard
   GenAI folders, not yet loaded on iOS - check each model's license first, see the README); a dataset folder `dataset/`
   (`cases.jsonl` + `audio/`, produced by `scripts\build_dataset.bat`).
   Without a grammar the default prompt fails (docs/IOS_SPIKE.md, "What losing the grammar costs"): export the flat prompts
   instead and copy that file as `golden_vectors.json`:
   `set "FV_PATCH_PROMPT=v3" && .venv\Scripts\python.exe -m backend.evalkit.golden_vectors --out ios-spike\golden\golden_vectors_v3.json`.
4. Build in **Release**, on a charged device, not in low-power mode. Run *LLM bench* and *Speech bench*; each writes a
   `results-*.json` into Documents (the harness records thermal state, footprint and the build type).
5. Back on the PC: `.venv\Scripts\python.exe -m backend.evalkit.ios_results <files> --dataset synth-v1`.

## Extending

Implement `LlmRunner` (`load`, `generate(system:user:maxTokens:grammar:)`, `unload`) for another backend - Apple
Foundation Models, MLX Swift, llama.cpp - or `SpeechRunner` for Whisper (WhisperKit / whisper.cpp / ORT) and the new iOS 26
SpeechAnalyzer; the benchmark loops, the memory probe and the results format stay the same.
