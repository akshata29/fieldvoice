import Foundation

/// Language-neutral vectors exported by `python -m backend.evalkit.golden_vectors`.
/// A Swift port of normalize/resolve must reproduce `normalizer` and `pipelineRulesOnly` exactly;
/// `llmPrompts` are the real prompts the Python pipeline sends (use them for LLM benchmarking).
public struct GoldenVectors: Codable {
    public struct Token: Codable, Equatable {
        public let text: String
        public let kind: String
        public let value: String?
        public let start: Int
        public let end: Int
    }

    public struct NormalizerCase: Codable {
        public let raw: String
        public let text: String
        public let clean: String
        public let tokens: [Token]
    }

    public struct FieldRecord: Codable {
        public let value: JSONValue?
        public let status: String
        public let confidence: Double
    }

    public struct PipelineCase: Codable {
        public let transcript: String
        public let expected: [String: JSONValue]
        public let fields: [String: FieldRecord]
    }

    public struct PromptCase: Codable {
        public let strategy: String
        public let transcript: String
        public let system: String
        public let user: String
        public let responseFormat: JSONValue?

        enum CodingKeys: String, CodingKey {
            case strategy, transcript, system, user
            case responseFormat = "response_format"
        }
    }

    public let version: Int
    public let form: JSONValue
    public let assets: [JSONValue]
    public let normalizerExtraIdTriggers: [String]
    public let normalizer: [NormalizerCase]
    public let pipelineRulesOnly: [PipelineCase]
    public let llmPrompts: [PromptCase]

    enum CodingKeys: String, CodingKey {
        case version, form, assets, normalizer
        case normalizerExtraIdTriggers = "normalizer_extra_id_triggers"
        case pipelineRulesOnly = "pipeline_rules_only"
        case llmPrompts = "llm_prompts"
    }

    public static func load(from url: URL) throws -> GoldenVectors {
        try JSONDecoder().decode(GoldenVectors.self, from: Data(contentsOf: url))
    }
}
