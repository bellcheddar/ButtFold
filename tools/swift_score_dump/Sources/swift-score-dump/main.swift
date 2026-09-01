// Dump PhoneFold's own Sonifier over a ButtFold baked fold, once, as the reference that
// `static/js/Sonifier.js` is tested against.
//
// PLAN.md section 10, item 3: "a one-off Swift dump from PhoneFoldKit's test target (run
// once on the Mac, committed to tests/fixtures/) provides Sonifier reference scores; the
// Node test runs Sonifier.js over a baked fold and asserts note-for-note identity (pitch,
// velocity, beat, voice) with the fixture."
//
// This is the whole point of the exercise. A JS sonifier tested against a JS fixture proves
// only that it has not changed. Tested against the *shipped Swift*, running the same
// trajectory, it proves that someone who plays with ButtFold and then downloads PhoneFold
// hears the same piece - which is a requirement, not a nicety.
//
// It is deliberately a throwaway: it is run by hand, its output is committed, and nothing in
// ButtFold's build or runtime depends on it or on Swift being installed. The `#if canImport`
// guards are there so the file is at least syntactically checkable without PhoneFoldKit.
//
//   tools/swift_score_dump/run.sh
//
// The frames handed to the Sonifier are reconstructed from ButtFold's baked artefact, not
// re-simulated, so both implementations are scored on byte-identical input. Coordinates come
// back out of the quantised box in Angstroms via the frame's own recorded Rg, because the Rg
// is the only real length the artefact still carries.

import Foundation
import simd
import FoldCore
import FoldAudio
import FoldGeometry

// MARK: - The baked artefact, as ButtFold writes it

struct BakedFrame: Decodable {
    let points: [Int]
    let newContacts: [[Int]]
    let ss: String
    let conf: [Int]
    let rg: Int
    let q: Int
}

struct BakedFold: Decodable {
    let id: String
    let name: String
    let sequence: String
    let residueCount: Int
    let frames: [BakedFrame]
}

struct Gallery: Decodable {
    let quantisedRange: Int
    let folds: [BakedFold]
}

func runLengthDecode(_ encoded: String) -> String {
    var out = "", digits = ""
    for ch in encoded {
        if ch.isNumber { digits.append(ch) } else {
            out += String(repeating: ch, count: Int(digits) ?? 1)
            digits = ""
        }
    }
    return out
}

// MARK: - Rebuilding the frames

func radiusOfGyration(_ ca: [SIMD3<Float>]) -> Float {
    guard !ca.isEmpty else { return 0 }
    var centre = SIMD3<Float>(repeating: 0)
    for p in ca { centre += p }
    centre /= Float(ca.count)
    var sum: Float = 0
    for p in ca { let d = p - centre; sum += simd_dot(d, d) }
    return (sum / Float(ca.count)).squareRoot()
}

func frames(from fold: BakedFold, residues: [AminoAcid]) -> [FoldFrame] {
    var built: [FoldFrame] = []
    for (index, frame) in fold.frames.enumerated() {
        // Quantised units back to Angstroms, using this frame's own recorded Rg as the ruler.
        var ca: [SIMD3<Float>] = []
        ca.reserveCapacity(fold.residueCount)
        for i in 0..<fold.residueCount {
            ca.append(SIMD3<Float>(Float(frame.points[3 * i]),
                                   Float(frame.points[3 * i + 1]),
                                   Float(frame.points[3 * i + 2])))
        }
        // Back to Angstroms, so that contact distances and everything derived from the
        // coordinates are in real units. The frame's recorded Rg is the ruler: it is the
        // only real length the quantised artefact still carries.
        let quantisedRg = radiusOfGyration(ca)
        let realRg = Float(frame.rg) / 10
        let scale = quantisedRg > 0 ? realRg / quantisedRg : 1
        ca = ca.map { $0 * scale }

        let ssString = Array(runLengthDecode(frame.ss))
        let assignment: [SSAssignment] = (0..<fold.residueCount).map { i in
            let structure: SecondaryStructure =
                ssString[i] == "H" ? .helix : (ssString[i] == "E" ? .sheet : .coil)
            return SSAssignment(structure: structure, confidence: 1)
        }

        let contacts: [ContactEvent] = frame.newContacts.map { pair in
            let i = pair[0], j = pair[1]
            let d = simd_distance(ca[i], ca[j])
            let hydrophobic = residues[i].isHydrophobic && residues[j].isHydrophobic
            return ContactEvent(i: i, j: j, distance: d, isHydrophobicPair: hydrophobic)
        }

        let confidence = frame.conf.map { Float($0) }
        let mean = confidence.isEmpty ? 0 : confidence.reduce(0, +) / Float(confidence.count)
        let backbone = ca.map { BackboneResidue(n: $0, ca: $0, c: $0, o: $0) }

        built.append(FoldFrame(
            index: index,
            // A Gō fold has no trunk recycles, so there is nothing to modulate on. Zero for
            // every frame, which is what a structure-based trajectory reports in the app.
            recycle: 0,
            blockIndex: index,
            backbone: backbone,
            pLDDT: confidence,
            secondaryStructure: assignment,
            newContacts: contacts,
            // The recorded value, NOT a recomputation from the rescaled coordinates.
            // Rescaling and then re-measuring returns a number a few ulps away from the one
            // it was scaled to, and `compaction` is sensitive enough that the difference
            // reaches the tempo. The JS reads the same recorded integer, so both
            // implementations start from the identical Float32.
            radiusOfGyration: realRg,
            meanPLDDT: mean,
            isInterpolated: false))
    }
    return built
}

// MARK: - Dump

struct NoteOut: Encodable {
    let voice: String
    let pitch: Int
    let velocity: Int
    let residue: Int
    let partner: Int?
    let beatOffset: Double
    let duration: Double
}

struct MomentOut: Encodable {
    let frameIndex: Int
    let tempo: Double
    let beats: Double
    let degree: Int
    let isCadence: Bool
    let isModulation: Bool
    let compaction: Double
    let droppedContacts: Int
    let establishedContacts: Int
    let cutoff: Double
    let detuneCents: Double
    let reverb: Double
    let notes: [NoteOut]
}

struct Dump: Encodable {
    let generatedBy: String
    let phonefoldCommit: String
    let foldId: String
    let styleId: String
    let residueCount: Int
    let sequence: String
    let readouts: Int
    let readoutsPerMoment: Int
    let beatsPerMoment: Double
    let moments: [MomentOut]
}

let arguments = CommandLine.arguments
guard arguments.count >= 4 else {
    FileHandle.standardError.write(
        "usage: swift-score-dump <gallery.json> <styles-dir> <output-dir>\n".data(using: .utf8)!)
    exit(2)
}
let galleryURL = URL(fileURLWithPath: arguments[1])
let stylesURL = URL(fileURLWithPath: arguments[2])
let outputURL = URL(fileURLWithPath: arguments[3])

let gallery = try JSONDecoder().decode(Gallery.self, from: Data(contentsOf: galleryURL))
let styles = try StyleLibrary.profiles(in: stylesURL)
try FileManager.default.createDirectory(at: outputURL, withIntermediateDirectories: true)

// Two folds and every style: enough to exercise all-helix, mixed alpha/beta, every voice and
// every progression, without committing a fixture per fold per style.
let chosenFolds = ["trp_cage", "ubiquitin"]
var index: [[String: String]] = []

for foldId in chosenFolds {
    guard let fold = gallery.folds.first(where: { $0.id == foldId }) else {
        FileHandle.standardError.write("no fold \(foldId)\n".data(using: .utf8)!)
        exit(1)
    }
    let residues = fold.sequence.map { AminoAcid(code: $0) }
    let built = frames(from: fold, residues: residues)

    for styleId in styles.keys.sorted() {
        let style = styles[styleId]!
        let pacing = Sonifier.pacing(readouts: built.count, style: style)
        var sonifier = Sonifier(style: style, residues: residues,
                                beatsPerMoment: pacing.beatsPerMoment,
                                readoutsPerMoment: pacing.readoutsPerMoment)
        let moments: [MomentOut] = built.compactMap { frame in
            guard let m = sonifier.moment(for: frame) else { return nil }
            return MomentOut(
                frameIndex: m.frameIndex, tempo: m.tempo, beats: m.beats, degree: m.degree,
                isCadence: m.isCadence, isModulation: m.isModulation,
                compaction: m.compaction, droppedContacts: m.droppedContacts,
                establishedContacts: m.establishedContacts,
                cutoff: m.timbre.cutoff, detuneCents: m.timbre.detuneCents,
                reverb: m.timbre.reverb,
                notes: m.notes.map {
                    NoteOut(voice: $0.voice.rawValue, pitch: Int($0.note.pitch),
                            velocity: Int($0.note.velocity), residue: $0.residue,
                            partner: $0.partner, beatOffset: $0.beatOffset,
                            duration: $0.duration)
                })
        }

        let dump = Dump(
            generatedBy: "PhoneFoldKit FoldAudio.Sonifier via ButtFold tools/swift_score_dump",
            phonefoldCommit: ProcessInfo.processInfo.environment["PHONEFOLD_COMMIT"] ?? "unknown",
            foldId: foldId, styleId: styleId, residueCount: fold.residueCount,
            sequence: fold.sequence, readouts: built.count,
            readoutsPerMoment: pacing.readoutsPerMoment,
            beatsPerMoment: pacing.beatsPerMoment, moments: moments)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let name = "\(foldId)-\(styleId).json"
        try encoder.encode(dump).write(to: outputURL.appendingPathComponent(name))
        let notes = moments.reduce(0) { $0 + $1.notes.count }
        print(String(format: "%-14s %-9s %3d moments, %5d notes, %d dropped",
                     (foldId as NSString).utf8String!, (styleId as NSString).utf8String!,
                     moments.count, notes,
                     moments.reduce(0) { $0 + $1.droppedContacts }))
        index.append(["fold": foldId, "style": styleId, "file": name])
    }
}

let indexData = try JSONSerialization.data(withJSONObject: ["cases": index],
                                           options: [.prettyPrinted, .sortedKeys])
try indexData.write(to: outputURL.appendingPathComponent("index.json"))
print("\nwrote \(index.count) reference scores to \(outputURL.path)")
