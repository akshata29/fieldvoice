import Foundation

public enum RunnerError: Error, CustomStringConvertible {
    case unavailable(String)
    case failed(String)

    public var description: String {
        switch self {
        case .unavailable(let m): return "unavailable: \(m)"
        case .failed(let m): return "failed: \(m)"
        }
    }
}

public struct LlmOutput {
    public var text: String
    public var promptTokens: Int
    public var outputTokens: Int
    public var ttftMs: Double
    public var totalMs: Double

    public init(text: String, promptTokens: Int, outputTokens: Int, ttftMs: Double, totalMs: Double) {
        self.text = text; self.promptTokens = promptTokens; self.outputTokens = outputTokens
        self.ttftMs = ttftMs; self.totalMs = totalMs
    }
}

/// An on-device language-model backend (ORT GenAI, Core ML, MLX, llama.cpp, Apple Foundation Models, ...).
public protocol LlmRunner: AnyObject {
    var id: String { get }
    var detail: String { get }
    func load() throws
    /// ``grammar`` is a Lark grammar (the same text the Python pipeline sends); runners that cannot constrain may ignore it.
    func generate(system: String, user: String, maxTokens: Int, grammar: String?) throws -> LlmOutput
    func unload()
}

public struct SpeechOutput {
    public var text: String
    public var audioMs: Double
    public var sttMs: Double
    public var firstPartialMs: Double?

    public init(text: String, audioMs: Double, sttMs: Double, firstPartialMs: Double?) {
        self.text = text; self.audioMs = audioMs; self.sttMs = sttMs; self.firstPartialMs = firstPartialMs
    }
}

/// An on-device speech-to-text backend (SFSpeechRecognizer, SpeechAnalyzer, WhisperKit, whisper.cpp, ORT Whisper, ...).
public protocol SpeechRunner: AnyObject {
    var id: String { get }
    var detail: String { get }
    func prepare() async throws
    func transcribe(fileURL: URL) async throws -> SpeechOutput
}
