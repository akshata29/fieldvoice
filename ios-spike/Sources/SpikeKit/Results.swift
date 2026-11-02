import Foundation

/// Result file written by every benchmark run. Read by `python -m backend.evalkit.ios_results <file>`.
public let resultsSchemaID = "fieldvoice.ios-bench.v1"

public struct DeviceInfo: Codable {
    public var machine: String            // e.g. "iPad12,1" (hw.machine)
    public var system: String             // OS version string
    public var physicalMemoryMB: Double
    public var processorCount: Int
    public var lowPowerMode: Bool
    public var thermalStateStart: String
    public var build: String              // "debug" | "release" - ALWAYS benchmark Release builds

    enum CodingKeys: String, CodingKey {
        case machine, system, build
        case physicalMemoryMB = "physical_memory_mb"
        case processorCount = "processor_count"
        case lowPowerMode = "low_power_mode"
        case thermalStateStart = "thermal_state_start"
    }

    public static func current() -> DeviceInfo {
        var size = 0
        sysctlbyname("hw.machine", nil, &size, nil, 0)
        var buffer = [CChar](repeating: 0, count: max(size, 1))
        sysctlbyname("hw.machine", &buffer, &size, nil, 0)
        let info = ProcessInfo.processInfo
        #if DEBUG
        let build = "debug"
        #else
        let build = "release"
        #endif
        return DeviceInfo(
            machine: String(cString: buffer), system: info.operatingSystemVersionString,
            physicalMemoryMB: Double(info.physicalMemory) / 1_048_576.0, processorCount: info.processorCount,
            lowPowerMode: info.isLowPowerModeEnabled, thermalStateStart: thermalName(info.thermalState), build: build)
    }
}

public func thermalName(_ state: ProcessInfo.ThermalState) -> String {
    switch state {
    case .nominal: return "nominal"
    case .fair: return "fair"
    case .serious: return "serious"
    case .critical: return "critical"
    @unknown default: return "unknown"
    }
}

public struct RunnerInfo: Codable {
    public var kind: String   // "llm" | "stt"
    public var id: String
    public var detail: String
}

public struct Footprint: Codable {
    public var beforeLoad: Double
    public var afterLoad: Double
    public var peak: Double

    enum CodingKeys: String, CodingKey {
        case beforeLoad = "before_load"
        case afterLoad = "after_load"
        case peak
    }
}

/// One measured execution. LLM runs fill the token/latency fields, speech runs fill the audio/transcript fields.
public struct RunRecord: Codable {
    public var caseId: String
    public var strategy: String?
    public var repeatIndex: Int
    public var promptTokens: Int?
    public var outputTokens: Int?
    public var ttftMs: Double?
    public var totalMs: Double?
    public var tokensPerS: Double?
    public var output: String?
    public var audioMs: Double?
    public var sttMs: Double?
    public var firstPartialMs: Double?
    public var transcript: String?
    public var thermalState: String
    public var error: String?

    enum CodingKeys: String, CodingKey {
        case strategy, output, transcript, error
        case caseId = "case_id"
        case repeatIndex = "repeat"
        case promptTokens = "prompt_tokens"
        case outputTokens = "output_tokens"
        case ttftMs = "ttft_ms"
        case totalMs = "total_ms"
        case tokensPerS = "tokens_per_s"
        case audioMs = "audio_ms"
        case sttMs = "stt_ms"
        case firstPartialMs = "first_partial_ms"
        case thermalState = "thermal_state"
    }

    public init(caseId: String, repeatIndex: Int = 0, thermalState: String) {
        self.caseId = caseId
        self.repeatIndex = repeatIndex
        self.thermalState = thermalState
    }
}

public struct BenchResults: Codable {
    public var schema: String = resultsSchemaID
    public var createdAt: String
    public var device: DeviceInfo
    public var runner: RunnerInfo
    public var loadMs: Double
    public var footprintMB: Footprint
    public var runs: [RunRecord]
    public var notes: [String]

    enum CodingKeys: String, CodingKey {
        case schema, device, runner, runs, notes
        case createdAt = "created_at"
        case loadMs = "load_ms"
        case footprintMB = "footprint_mb"
    }

    public func write(to directory: URL) throws -> URL {
        let formatter = ISO8601DateFormatter()
        let stamp = formatter.string(from: Date()).replacingOccurrences(of: ":", with: "")
        let url = directory.appendingPathComponent("results-\(runner.kind)-\(runner.id.replacingOccurrences(of: "/", with: "_"))-\(stamp).json")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(self).write(to: url, options: .atomic)
        return url
    }
}
