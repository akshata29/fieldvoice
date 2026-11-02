# ios-spike

Starting kit for the iOS feasibility spike described in [docs/IOS_SPIKE.md](../docs/IOS_SPIKE.md).

> **Not compiled or run** - written without access to a Mac/Xcode. The Python tooling that consumes its output is tested.

## Contents

| Path | Purpose |
|---|---|
| `golden/golden_vectors.json` | Language-neutral vectors from the Python implementation: normalizer tokens/offsets, rules-only field results, real LLM prompts + grammars. Regenerate: `python -m backend.evalkit.golden_vectors` (a Python test fails if the file is stale). |
| `Package.swift`, `Sources/SpikeKit` | Swift package: golden-vector decoding, the results schema, memory probe, benchmark loops, runner protocols, Apple on-device speech runner. |
| `Tests/SpikeKitTests` | Decodes the vectors and checks the results schema (`swift test` on a Mac). |
| `AppTemplate/` | `BenchApp.swift` (SwiftUI harness), `OrtGenAIRunner.{h,mm}` (Objective-C++ over the ORT GenAI C++ API) and its Swift adapter. Add to an Xcode iOS app target. |

## Steps

1. **Build ONNX Runtime and ONNX Runtime GenAI for iOS (arm64)** from the same release (GenAI lists iOS as roadmap - this
   is a build-from-source task; start from the official `LocalLLM` Phi-3 sample's project settings). Put `ort_genai.h`
   from that build in the header search path and link the static libraries.
2. Create an iOS App target in Xcode; add this package (`SpikeKit`) and the files in `AppTemplate/`. In the bridging header
   add `#import "OrtGenAIRunner.h"`. In *Info.plist* set `NSSpeechRecognitionUsageDescription`,
   `UIFileSharingEnabled = YES` and `LSSupportsOpeningDocumentsInPlace = YES`.
3. Copy to the app's **Documents** (Finder → device → Files, or Xcode → Devices): `golden_vectors.json`; ONNX GenAI model
   folders under `models/<name>/` (each with `genai_config.json`); a dataset folder `dataset/` (`cases.jsonl` + `audio/`,
   produced by `scripts\build_dataset.bat`).
4. Build in **Release**, on a charged device, not in low-power mode. Run *LLM bench* and *Speech bench*; each writes a
   `results-*.json` into Documents (the harness records thermal state, footprint and the build type).
5. Back on the PC: `.venv\Scripts\python.exe -m backend.evalkit.ios_results <files> --dataset synth-v1`.

## Extending

Implement `LlmRunner` (`load`, `generate(system:user:maxTokens:grammar:)`, `unload`) for another backend - Apple
Foundation Models, MLX Swift, llama.cpp - or `SpeechRunner` for Whisper (WhisperKit / whisper.cpp / ORT) and the new iOS 26
SpeechAnalyzer; the benchmark loops, the memory probe and the results format stay the same.
