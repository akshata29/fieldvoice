import Foundation

public enum LlmBench {
    /// Runs every captured Python prompt ``repeats`` times through ``runner`` and records latency, tokens, footprint.
    /// One untimed warm-up generation precedes the measured runs. Use a Release build on a charged, cool device.
    public static func run(
        runner: LlmRunner, vectors: GoldenVectors, repeats: Int = 3, maxTokens: Int = 96, useGrammar: Bool = true,
        progress: ((String) -> Void)? = nil
    ) -> BenchResults {
        let device = DeviceInfo.current()
        var notes: [String] = []
        let before = MemoryProbe.footprintMB()
        let sampler = PeakSampler()
        sampler.start()

        var loadMs = 0.0
        let t0 = DispatchTime.now()
        do { try runner.load() } catch {
            notes.append("load failed: \(error)")
            return finish(device, runner, 0, before, before, sampler.stop(), [], notes)
        }
        loadMs = elapsedMs(since: t0)
        let after = MemoryProbe.footprintMB()
        progress?("loaded \(runner.id) in \(Int(loadMs)) ms, footprint \(Int(after)) MB")

        func grammar(for p: GoldenVectors.PromptCase) -> String? {
            guard useGrammar, let rf = p.responseFormat?.objectValue, rf["type"]?.stringValue == "lark_grammar" else { return nil }
            return rf["lark_grammar"]?.stringValue
        }

        if let first = vectors.llmPrompts.first {
            _ = try? runner.generate(system: first.system, user: first.user, maxTokens: maxTokens, grammar: grammar(for: first))
        }

        var runs: [RunRecord] = []
        for (index, prompt) in vectors.llmPrompts.enumerated() {
            for r in 0..<repeats {
                var rec = RunRecord(caseId: "prompt-\(index)", repeatIndex: r, thermalState: thermalName(ProcessInfo.processInfo.thermalState))
                rec.strategy = prompt.strategy
                do {
                    let out = try runner.generate(system: prompt.system, user: prompt.user, maxTokens: maxTokens, grammar: grammar(for: prompt))
                    rec.promptTokens = out.promptTokens
                    rec.outputTokens = out.outputTokens
                    rec.ttftMs = out.ttftMs
                    rec.totalMs = out.totalMs
                    let decodeMs = out.totalMs - out.ttftMs
                    if out.outputTokens > 1, decodeMs > 0 { rec.tokensPerS = Double(out.outputTokens - 1) * 1000.0 / decodeMs }
                    rec.output = out.text
                } catch {
                    rec.error = "\(error)"
                }
                runs.append(rec)
                progress?("[\(prompt.strategy)] prompt \(index) run \(r + 1)/\(repeats): \(rec.totalMs.map { "\(Int($0)) ms" } ?? "error")")
            }
        }
        let peak = sampler.stop()
        runner.unload()
        return finish(device, runner, loadMs, before, after, peak, runs, notes)
    }

    private static func finish(_ device: DeviceInfo, _ runner: LlmRunner, _ loadMs: Double, _ before: Double, _ after: Double,
                               _ peak: Double, _ runs: [RunRecord], _ notes: [String]) -> BenchResults {
        BenchResults(
            createdAt: ISO8601DateFormatter().string(from: Date()), device: device,
            runner: RunnerInfo(kind: "llm", id: runner.id, detail: runner.detail), loadMs: loadMs,
            footprintMB: Footprint(beforeLoad: before, afterLoad: after, peak: peak), runs: runs, notes: notes)
    }
}

func elapsedMs(since start: DispatchTime) -> Double {
    Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000.0
}
