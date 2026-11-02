// NOT COMPILED OR RUN in the environment that produced it (no Mac / Xcode).
// Copy into the app target together with OrtGenAIRunner.h/.mm and add this line to the bridging header:
//   #import "OrtGenAIRunner.h"
import Foundation
import SpikeKit

final class OrtGenAISwiftRunner: LlmRunner {
    let id: String
    var detail: String { "ONNX Runtime GenAI (iOS build) model=\(modelPath.lastPathComponent)" }
    private let modelPath: URL
    private var runner: OrtGenAIRunner?

    init(modelPath: URL, id: String? = nil) {
        self.modelPath = modelPath
        self.id = id ?? "ort-genai:\(modelPath.lastPathComponent)"
    }

    func load() throws {
        var error: NSError?
        runner = OrtGenAIRunner(modelPath: modelPath.path, error: &error)
        if let error = error { throw RunnerError.failed(error.localizedDescription) }
        guard runner != nil else { throw RunnerError.unavailable("model did not load") }
    }

    func generate(system: String, user: String, maxTokens: Int, grammar: String?) throws -> LlmOutput {
        guard let runner = runner else { throw RunnerError.unavailable("call load() first") }
        var error: NSError?
        guard let r = runner.generate(withSystem: system, user: user, maxTokens: maxTokens, grammar: grammar, error: &error) else {
            throw RunnerError.failed(error?.localizedDescription ?? "generation failed")
        }
        return LlmOutput(text: r.text, promptTokens: r.promptTokens, outputTokens: r.outputTokens, ttftMs: r.ttftMs, totalMs: r.totalMs)
    }

    func unload() { runner = nil }
}
