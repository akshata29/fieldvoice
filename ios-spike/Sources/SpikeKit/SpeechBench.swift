import Foundation

public enum SpeechBench {
    private struct DatasetCase: Decodable {
        let id: String
        let audioPath: String?

        enum CodingKeys: String, CodingKey {
            case id
            case audioPath = "audio_path"
        }
    }

    /// Transcribes every audio case of a dataset folder (``cases.jsonl`` + ``audio/*.wav``, as produced by the Python
    /// dataset builder and copied onto the device) and records latency + the transcript. Scoring (WER, identifier match)
    /// is done offline by `python -m backend.evalkit.ios_results` so iOS and Windows numbers use the same code.
    public static func run(
        runner: SpeechRunner, datasetDir: URL, limit: Int? = nil, progress: ((String) -> Void)? = nil
    ) async -> BenchResults {
        let device = DeviceInfo.current()
        var notes: [String] = []
        var runs: [RunRecord] = []
        let before = MemoryProbe.footprintMB()
        let sampler = PeakSampler()
        sampler.start()
        let t0 = DispatchTime.now()
        do { try await runner.prepare() } catch {
            notes.append("prepare failed: \(error)")
            return make(device, runner, 0, before, before, sampler.stop(), runs, notes)
        }
        let prepareMs = elapsedMs(since: t0)
        let after = MemoryProbe.footprintMB()

        let cases = loadCases(datasetDir).filter { $0.audioPath != nil }
        for (i, c) in cases.prefix(limit ?? Int.max).enumerated() {
            var rec = RunRecord(caseId: c.id, thermalState: thermalName(ProcessInfo.processInfo.thermalState))
            do {
                let out = try await runner.transcribe(fileURL: datasetDir.appendingPathComponent(c.audioPath!))
                rec.transcript = out.text
                rec.audioMs = out.audioMs
                rec.sttMs = out.sttMs
                rec.firstPartialMs = out.firstPartialMs
            } catch {
                rec.error = "\(error)"
            }
            runs.append(rec)
            progress?("\(i + 1)/\(cases.count) \(c.id): \(rec.sttMs.map { "\(Int($0)) ms" } ?? "error")")
        }
        return make(device, runner, prepareMs, before, after, sampler.stop(), runs, notes)
    }

    private static func loadCases(_ dir: URL) -> [DatasetCase] {
        guard let text = try? String(contentsOf: dir.appendingPathComponent("cases.jsonl"), encoding: .utf8) else { return [] }
        let decoder = JSONDecoder()
        return text.split(separator: "\n").compactMap { try? decoder.decode(DatasetCase.self, from: Data($0.utf8)) }
    }

    private static func make(_ device: DeviceInfo, _ runner: SpeechRunner, _ loadMs: Double, _ before: Double, _ after: Double,
                             _ peak: Double, _ runs: [RunRecord], _ notes: [String]) -> BenchResults {
        BenchResults(
            createdAt: ISO8601DateFormatter().string(from: Date()), device: device,
            runner: RunnerInfo(kind: "stt", id: runner.id, detail: runner.detail), loadMs: loadMs,
            footprintMB: Footprint(beforeLoad: before, afterLoad: after, peak: peak), runs: runs, notes: notes)
    }
}
