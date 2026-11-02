// NOT COMPILED OR RUN in the environment that produced it (no Mac / Xcode).
// Minimal SwiftUI harness: pick a benchmark, watch the log, then collect results-*.json from the app's Documents folder.
import SpikeKit
import SwiftUI

@main
struct BenchApp: App {
    var body: some Scene { WindowGroup { ContentView() } }
}

struct ContentView: View {
    @State private var log = ""
    @State private var running = false

    private let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("FieldVoice iOS spike").font(.headline)
            Text("Documents/models/<name>/ = ONNX GenAI model folder;  Documents/dataset/ = cases.jsonl + audio/;  Documents/golden_vectors.json")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("LLM bench (ORT GenAI)") { run { await llmBench() } }
                Button("Speech bench (Apple on-device)") { run { await speechBench() } }
            }
            .buttonStyle(.borderedProminent).disabled(running)
            ScrollView {
                Text(log).font(.system(.footnote, design: .monospaced)).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding()
    }

    private func run(_ work: @escaping () async -> Void) {
        running = true
        Task { await work(); running = false }
    }

    private func append(_ line: String) { DispatchQueue.main.async { log += line + "\n" } }

    private func llmBench() async {
        do {
            let vectors = try GoldenVectors.load(from: docs.appendingPathComponent("golden_vectors.json"))
            let models = try FileManager.default.contentsOfDirectory(at: docs.appendingPathComponent("models"), includingPropertiesForKeys: nil)
            for model in models where model.hasDirectoryPath {
                append("== \(model.lastPathComponent)")
                let results = await Task.detached {
                    LlmBench.run(runner: OrtGenAISwiftRunner(modelPath: model), vectors: vectors, repeats: 3) { self.append($0) }
                }.value
                append("wrote \(try results.write(to: docs).lastPathComponent)")
            }
        } catch { append("error: \(error)") }
    }

    private func speechBench() async {
        do {
            let runner = try AppleSpeechRunner()
            let results = await SpeechBench.run(runner: runner, datasetDir: docs.appendingPathComponent("dataset")) { append($0) }
            append("wrote \(try results.write(to: docs).lastPathComponent)")
        } catch { append("error: \(error)") }
    }
}
