import SwiftUI

/// The salu dog from the TUI (src/tui/dog/sprites.ts), drawn as square pixels. It runs while the
/// box is working on a ticket and sleeps otherwise; tap it and it barks (the dojjan egg).
struct DogView: View {
    enum Mood { case running, sleeping }
    var mood: Mood
    var pixel: CGFloat = 3
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var barkStart: Date?

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.1, paused: reduceMotion && barkStart == nil)) { context in
            let current = frame(at: context.date)
            DogPixels(rows: current.rows, pixel: pixel)
                .overlay(alignment: .topTrailing) {
                    if let say = current.say {
                        Text(say)
                            .font(.system(size: max(9, pixel * 3), weight: .heavy, design: .monospaced))
                            .foregroundStyle(Salu.accent)
                            .fixedSize()
                            .offset(x: pixel * 8, y: pixel)
                    }
                }
        }
        .frame(width: CGFloat(DogSprites.width) * pixel, height: CGFloat(DogSprites.height) * pixel, alignment: .bottomLeading)
        .contentShape(Rectangle())
        .onTapGesture { barkStart = Date() }
        .sensoryFeedback(.impact(weight: .light), trigger: barkStart)
        .accessibilityElement()
        .accessibilityLabel(mood == .running ? "salu dog, running: the box is working" : "salu dog, asleep: nothing running")
    }

    private func frame(at date: Date) -> (rows: [String], say: String?) {
        if let start = barkStart {
            var t = date.timeIntervalSince(start)
            for f in DogSprites.bark {
                if t < f.seconds { return (f.rows, f.say) }
                t -= f.seconds
            }
        }
        let tick = Int(date.timeIntervalSinceReferenceDate * 10)  // 10 fps, like the TUI
        switch mood {
        case .running:
            return (DogSprites.run[reduceMotion ? 0 : tick % DogSprites.run.count], nil)
        case .sleeping:
            return (DogSprites.sleep[reduceMotion ? 0 : (tick / 15) % DogSprites.sleep.count], nil)
        }
    }
}

/// One frame: A accent, M ok, D chrome, T pale text, z and Z drawn as letters, '.' transparent.
struct DogPixels: View {
    let rows: [String]
    let pixel: CGFloat

    var body: some View {
        Canvas { ctx, _ in
            for (y, row) in rows.enumerated() {
                for (x, ch) in row.enumerated() {
                    let rect = CGRect(x: CGFloat(x) * pixel, y: CGFloat(y) * pixel, width: pixel, height: pixel)
                    switch ch {
                    case "A": ctx.fill(Path(rect), with: .color(Salu.accent))
                    case "M": ctx.fill(Path(rect), with: .color(Salu.ok))
                    case "D": ctx.fill(Path(rect), with: .color(Salu.chrome))
                    case "T": ctx.fill(Path(rect), with: .color(Salu.text))
                    case "z", "Z":
                        let big = ch == "Z"
                        let letter: Text = Text(String(ch))
                            .font(.system(size: pixel * (big ? 3.2 : 2.4), weight: .bold, design: .monospaced))
                            .foregroundStyle(big ? Salu.text : Salu.chrome)
                        ctx.draw(letter, at: CGPoint(x: rect.midX, y: rect.maxY + pixel), anchor: .bottom)
                    default: break
                    }
                }
            }
        }
        .frame(width: CGFloat(DogSprites.width) * pixel, height: CGFloat(DogSprites.height) * pixel)
    }
}

enum DogSprites {
    static let width = 26
    static let height = 12

    struct Frame {
        let seconds: Double
        let say: String?
        let rows: [String]
    }

    static let run: [[String]] = [
        [
            "..................D.....",
            ".................AA.....",
            ".T...............AAAA...",
            "..M.............AA.AAAA.",
            "..MM............AAAAAAAD",
            "...MM...AAAAAAAAAAAA....",
            "....MAAAAAAAAAAAAAAA....",
            ".....AAAAMMMMMAAAAAA....",
            ".....MAAM......MAAM.....",
            ".....MMDD........MMD....",
            "...MMDD............MMD..",
            ".MM.D................MM.",
        ],
        [
            "..................D.....",
            ".................AA.....",
            ".T...............AAAA...",
            "..M.............AA.AAAA.",
            "..MM............AAAAAAAD",
            "...MM...AAAAAAAAAAAA....",
            "....MAAAAAAAAAAAAAAA....",
            ".....AAAAMMMMMAAAAAA....",
            ".....MAAM......MAAM.....",
            ".....D.M.......D.M......",
            "....D...M.....D..M......",
            "...D.....MM..D...MM.....",
        ],
        [
            ".................AA.....",
            ".T...............AAAA...",
            "..M.............AA.AAAA.",
            "..MM............AAAAAAAD",
            "...MM...AAAAAAAAAAAA....",
            "....MAAAAAAAAAAAAAAA....",
            ".....AAAAMMMMMAAAAAA....",
            ".....MAAM......MAAM.....",
            ".......MD.......DM......",
            "........MDD...DDM.......",
            ".........MMD.DMM........",
            "...........M.M..........",
        ],
        [
            "..................D.....",
            ".................AA.....",
            ".T...............AAAA...",
            "..M.............AA.AAAA.",
            "..MM............AAAAAAAD",
            "...MM...AAAAAAAAAAAA....",
            "....MAAAAAAAAAAAAAAA....",
            ".....AAAAMMMMMAAAAAA....",
            ".....MAAM......MAAM.....",
            "......M.D.......D.MM....",
            "......M..D......D...MM..",
            "....MM...D.......D......",
        ],
    ]
    static let sleep: [[String]] = [
        [
            ".......................Z..",
            "..........................",
            "..................D..z....",
            ".................AA.......",
            ".................AAAA.....",
            "................AADDAAA...",
            "................AAAAAAAD..",
            "......MMMMMMMMMMAAAAA.....",
            "....MMMMMDMMMMMMMAAA......",
            "..T.MMMMDMMMMMMMMMM.......",
            ".T.MMMMDMMMMMMMMMMM.......",
            ".TTTMMMTTTTT...MMTTTTTTTT.",
        ],
        [
            "......................z..Z",
            "..........................",
            "..................D.......",
            ".................AA.......",
            ".................AAAA.....",
            "................AADDAAA...",
            "................AAAAAAAD..",
            "......MMMMMMMMMMAAAAA.....",
            "....MMMMMDMMMMMMMAAA......",
            "..T.MMMMDMMMMMMMMMM.......",
            ".T.MMMMDMMMMMMMMMMM.......",
            ".TTTMMMTTTTT...MMTTTTTTTT.",
        ],
    ]
    static let bark: [Frame] = [
        Frame(seconds: 0.45, say: nil, rows: [
            "..........................",
            "..........................",
            "..................D.......",
            ".................AA.......",
            ".................AAAA.....",
            "................AA.AAAA...",
            "................AAAAAAAD..",
            "......MMMMMMMMMMAAAAA.....",
            "....MMMMMDMMMMMMMAAA......",
            "..T.MMMMDMMMMMMMMMM.......",
            ".T.MMMMDMMMMMMMMMMM.......",
            ".TTTMMMTTTTT...MMTTTTTTTT.",
        ]),
        Frame(seconds: 0.26, say: "WOOF!", rows: [
            "..........................",
            "..................D.......",
            ".................AA.......",
            ".................AAAA.....",
            "................AA.AAAAD..",
            "................AAAA......",
            "................AAAAAA....",
            "......MMMMMMMMMMAAAAA.....",
            "....MMMMMDMMMMMMMAAA......",
            "..T.MMMMDMMMMMMMMMM.......",
            ".T.MMMMDMMMMMMMMMMM.......",
            ".TTTMMMTTTTT...MMTTTTTTTT.",
        ]),
        Frame(seconds: 0.2, say: nil, rows: [
            "..........................",
            "..........................",
            "..................D.......",
            ".................AA.......",
            ".................AAAA.....",
            "................AA.AAAA...",
            "................AAAAAAAD..",
            "......MMMMMMMMMMAAAAA.....",
            "....MMMMMDMMMMMMMAAA......",
            "..T.MMMMDMMMMMMMMMM.......",
            ".T.MMMMDMMMMMMMMMMM.......",
            ".TTTMMMTTTTT...MMTTTTTTTT.",
        ]),
        Frame(seconds: 0.26, say: "WOOF!", rows: [
            "..........................",
            "..................D.......",
            ".................AA.......",
            ".................AAAA.....",
            "................AA.AAAAD..",
            "................AAAA......",
            "................AAAAAA....",
            "......MMMMMMMMMMAAAAA.....",
            "....MMMMMDMMMMMMMAAA......",
            "..T.MMMMDMMMMMMMMMM.......",
            ".T.MMMMDMMMMMMMMMMM.......",
            ".TTTMMMTTTTT...MMTTTTTTTT.",
        ]),
        Frame(seconds: 0.7, say: nil, rows: [
            "..........................",
            "..........................",
            "..................D.......",
            ".................AA.......",
            ".................AAAA.....",
            "................AA.AAAA...",
            "................AAAAAAAD..",
            "......MMMMMMMMMMAAAAA.....",
            "....MMMMMDMMMMMMMAAA......",
            "..T.MMMMDMMMMMMMMMM.......",
            ".T.MMMMDMMMMMMMMMMM.......",
            ".TTTMMMTTTTT...MMTTTTTTTT.",
        ]),
        Frame(seconds: 0.5, say: nil, rows: [
            "..........................",
            "..........................",
            "..................D.......",
            ".................AA.......",
            ".................AAAA.....",
            "................AADDAAA...",
            "................AAAAAAAD..",
            "......MMMMMMMMMMAAAAA.....",
            "....MMMMMDMMMMMMMAAA......",
            "..T.MMMMDMMMMMMMMMM.......",
            ".T.MMMMDMMMMMMMMMMM.......",
            ".TTTMMMTTTTT...MMTTTTTTTT.",
        ]),
    ]
}
