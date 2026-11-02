#if canImport(Speech) && canImport(AVFoundation)
import AVFoundation
import Foundation
import Speech

/// Apple's built-in recognizer forced to on-device mode (`requiresOnDeviceRecognition = true`): the zero-model-download
/// baseline for iOS. The newer iOS 26 `SpeechAnalyzer` / `SpeechTranscriber` API is a separate candidate - add a second
/// `SpeechRunner` for it (see docs/IOS_SPIKE.md) and compare both against Whisper-class models.
public final class AppleSpeechRunner: SpeechRunner {
    public let id = "apple:sfspeech:on-device"
    public var detail: String { "SFSpeechRecognizer, requiresOnDeviceRecognition=true, locale \(recognizer.locale.identifier)" }
    private let recognizer: SFSpeechRecognizer

    public init(locale: Locale = Locale(identifier: "en-US")) throws {
        guard let r = SFSpeechRecognizer(locale: locale) else {
            throw RunnerError.unavailable("no recognizer for \(locale.identifier)")
        }
        recognizer = r
    }

    public func prepare() async throws {
        let status = await withCheckedContinuation { (c: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
        }
        guard status == .authorized else { throw RunnerError.unavailable("speech recognition not authorized (\(status.rawValue))") }
        guard recognizer.supportsOnDeviceRecognition else {
            throw RunnerError.unavailable("on-device recognition is not available for this locale/device")
        }
    }

    public func transcribe(fileURL: URL) async throws -> SpeechOutput {
        let file = try AVAudioFile(forReading: fileURL)
        let audioMs = Double(file.length) / file.fileFormat.sampleRate * 1000.0
        let request = SFSpeechURLRecognitionRequest(url: fileURL)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        let started = DispatchTime.now()
        let state = CallbackState()
        return try await withCheckedThrowingContinuation { continuation in
            state.task = recognizer.recognitionTask(with: request) { result, error in
                if let result = result {
                    state.markPartial(elapsedMs(since: started))
                    if result.isFinal, state.finish() {
                        continuation.resume(returning: SpeechOutput(
                            text: result.bestTranscription.formattedString, audioMs: audioMs,
                            sttMs: elapsedMs(since: started), firstPartialMs: state.firstPartialMs))
                    }
                } else if let error = error, state.finish() {
                    continuation.resume(throwing: RunnerError.failed(error.localizedDescription))
                }
            }
        }
    }
}

private final class CallbackState {
    private let lock = NSLock()
    private var done = false
    private var firstPartial: Double?
    var task: SFSpeechRecognitionTask?

    var firstPartialMs: Double? { lock.lock(); defer { lock.unlock() }; return firstPartial }

    func markPartial(_ ms: Double) {
        lock.lock(); defer { lock.unlock() }
        if firstPartial == nil { firstPartial = ms }
    }

    /// Returns true exactly once, so the continuation is resumed a single time.
    func finish() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}
#endif
