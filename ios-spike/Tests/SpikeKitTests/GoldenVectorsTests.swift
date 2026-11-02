import XCTest
@testable import SpikeKit

final class GoldenVectorsTests: XCTestCase {
    private var vectorsURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("golden/golden_vectors.json")
    }

    func testVectorsDecode() throws {
        let v = try GoldenVectors.load(from: vectorsURL)
        XCTAssertEqual(v.version, 1)
        XCTAssertFalse(v.normalizer.isEmpty)
        XCTAssertFalse(v.pipelineRulesOnly.isEmpty)
        XCTAssertFalse(v.llmPrompts.isEmpty)
        // offsets are Python str indices = Unicode scalars (not Swift Characters)
        for c in v.normalizer {
            let scalars = Array(c.text.unicodeScalars)
            for t in c.tokens {
                let piece = String(String.UnicodeScalarView(scalars[t.start..<t.end]))
                XCTAssertEqual(piece, t.text, c.raw)
            }
        }
    }

    func testResultsRoundTrip() throws {
        var rec = RunRecord(caseId: "c1", thermalState: "nominal")
        rec.totalMs = 1234
        let results = BenchResults(
            createdAt: "2026-01-01T00:00:00Z", device: DeviceInfo.current(),
            runner: RunnerInfo(kind: "llm", id: "test", detail: ""), loadMs: 1,
            footprintMB: Footprint(beforeLoad: 1, afterLoad: 2, peak: 3), runs: [rec], notes: [])
        let data = try JSONEncoder().encode(results)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["schema"] as? String, resultsSchemaID)
        XCTAssertNotNil(json["footprint_mb"])
        XCTAssertNotNil((json["runs"] as? [[String: Any]])?.first?["total_ms"])
    }
}
