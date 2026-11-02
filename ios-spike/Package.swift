// swift-tools-version:5.9
// NOT COMPILED OR RUN in the environment that produced it (no Mac / Xcode available). Treat as a starting scaffold.
import PackageDescription

let package = Package(
    name: "FieldVoiceSpike",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "SpikeKit", targets: ["SpikeKit"]),
    ],
    targets: [
        .target(name: "SpikeKit"),
        .testTarget(name: "SpikeKitTests", dependencies: ["SpikeKit"]),
    ]
)
