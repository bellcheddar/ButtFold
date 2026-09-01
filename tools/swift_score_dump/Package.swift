// swift-tools-version: 6.0
//
// A throwaway package whose only job is to run PhoneFold's own Sonifier over ButtFold's
// baked gallery and write the reference scores that `Sonifier.js` is tested against.
//
// It depends on PhoneFoldKit **by path** rather than vendoring FoldAudio. That is the whole
// point: the fixture has to agree with the SHIPPED Swift, and a vendored copy would drift
// until the test was quietly checking ButtFold against ButtFold. The path dependency is
// tolerable here, and only here, because nothing in ButtFold's build, tests or runtime uses
// this package: it is run by hand and its OUTPUT is what gets committed.
import PackageDescription

// Overridable so the dump can be regenerated on a machine that keeps PhoneFold elsewhere.
let phoneFoldKit = Context.environment["PHONEFOLDKIT"]
    ?? "/Users/dellboy/Documents/Vibe_Coding/PhoneFold/PhoneFoldKit"

let package = Package(
    name: "swift-score-dump",
    platforms: [.macOS(.v15)],   // matches PhoneFoldKit's own floor
    dependencies: [.package(path: phoneFoldKit)],
    targets: [
        .executableTarget(
            name: "swift-score-dump",
            dependencies: [
                .product(name: "FoldCore", package: "PhoneFoldKit"),
                .product(name: "FoldAudio", package: "PhoneFoldKit"),
                .product(name: "FoldGeometry", package: "PhoneFoldKit"),
            ]),
    ])
