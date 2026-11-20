import Foundation
import Testing
@testable import TTSCore

/// 记录型引擎：记下每次 synthesize 的入参，按调用顺序产出一个可识别的 chunk。
/// chunkDelay > 0 时每个 chunk 之间挂起，便于测试中途取消。
final class RecordingEngine: InferenceEngine, @unchecked Sendable {
    struct Call: Equatable {
        var text: String
        var voiceID: String
        var instruction: String?
    }

    private let lock = NSLock()
    private var _calls: [Call] = []
    let chunksPerCall: Int
    let chunkDelay: TimeInterval
    let failOnText: String?

    init(chunksPerCall: Int = 1, chunkDelay: TimeInterval = 0, failOnText: String? = nil) {
        self.chunksPerCall = chunksPerCall
        self.chunkDelay = chunkDelay
        self.failOnText = failOnText
    }

    var calls: [Call] {
        lock.lock()
        defer { lock.unlock() }
        return _calls
    }

    func synthesize(text: String, voice: Voice, options: SynthesisOptions) -> AsyncThrowingStream<AudioChunk, Error> {
        lock.lock()
        _calls.append(Call(text: text, voiceID: voice.id, instruction: options.instruction))
        let callIndex = _calls.count - 1
        lock.unlock()

        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    if let failOnText, text == failOnText {
                        throw InferenceError.generationFailed("scripted failure")
                    }
                    for _ in 0 ..< chunksPerCall {
                        try Task.checkCancellation()
                        if chunkDelay > 0 {
                            try await Task.sleep(for: .seconds(chunkDelay))
                        }
                        continuation.yield(AudioChunk(samples: [Float(callIndex)], sampleRate: 24_000))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

struct DialogueScriptTests {
    @Test func twoRoleScriptParsesRolesAndText() {
        let lines = DialogueScript.parse("Vivian：你好呀。\nEric：吃了吗？")
        #expect(lines == [
            DialogueLine(role: "Vivian", text: "你好呀。"),
            DialogueLine(role: "Eric", text: "吃了吗？"),
        ])
    }

    @Test func unmarkedTextBecomesSingleNarration() {
        let lines = DialogueScript.parse("这是一段没有任何角色标记的普通文本。\n第二行也没有。")
        #expect(lines == [DialogueLine(role: nil, text: "这是一段没有任何角色标记的普通文本。\n第二行也没有。")])
    }

    @Test func emptyTextYieldsNothing() {
        #expect(DialogueScript.parse("  \n\n  ").isEmpty)
    }

    @Test func longPrefixBeforeColonIsNotRoleMarker() {
        let text = "他停顿了很久然后终于开口说出了那句话：我走了"
        #expect(DialogueScript.parse(text) == [DialogueLine(role: nil, text: text)])
    }

    @Test func prefixWithSentencePunctuationIsNotRoleMarker() {
        let text = "你没看见吗？他说：好。"
        #expect(DialogueScript.parse(text) == [DialogueLine(role: nil, text: text)])
    }

    @Test func inlineInstructionParsedFromParentheses() {
        let lines = DialogueScript.parse("Vivian（用愤怒的语气）：够了！\nEric (whisper): fine.")
        #expect(lines == [
            DialogueLine(role: "Vivian", text: "够了！", instruction: "用愤怒的语气"),
            DialogueLine(role: "Eric", text: "fine.", instruction: "whisper"),
        ])
    }

    @Test func parenthesesInsideDialogueAreNotInstruction() {
        let lines = DialogueScript.parse("Vivian：今天（大概）会下雨。")
        #expect(lines == [DialogueLine(role: "Vivian", text: "今天（大概）会下雨。")])
    }

    @Test func emptyParenthesesMeanNoInstruction() {
        let lines = DialogueScript.parse("Vivian（）：你好。")
        #expect(lines == [DialogueLine(role: "Vivian", text: "你好。")])
    }

    @Test func differentInlineInstructionBreaksMerge() {
        let lines = DialogueScript.parse("Vivian（愤怒）：够了！\nVivian（平静）：算了。\nVivian（平静）：走吧。")
        #expect(lines == [
            DialogueLine(role: "Vivian", text: "够了！", instruction: "愤怒"),
            DialogueLine(role: "Vivian", text: "算了。\n走吧。", instruction: "平静"),
        ])
    }

    @Test func consecutiveSameRoleLinesMerge() {
        let lines = DialogueScript.parse("Vivian：第一句。\nVivian：第二句。\nEric：换人了。")
        #expect(lines == [
            DialogueLine(role: "Vivian", text: "第一句。\n第二句。"),
            DialogueLine(role: "Eric", text: "换人了。"),
        ])
    }

    @Test func mixedScriptWithNarrationEnglishColonAndSpacedName() {
        let lines = DialogueScript.parse("""
        深夜的茶馆。

        Uncle Fu: 坐。
        续的第二行归属 Uncle Fu。
        Vivian：来了。
        """)
        #expect(lines == [
            DialogueLine(role: nil, text: "深夜的茶馆。"),
            DialogueLine(role: "Uncle Fu", text: "坐。\n续的第二行归属 Uncle Fu。"),
            DialogueLine(role: "Vivian", text: "来了。"),
        ])
    }
}

struct DialogueSynthesizerTests {
    private let vivian = Voice.presets[0]
    private let eric = Voice.presets[4]
    private let narrator = Voice.presets[6]

    @Test func synthesizesLinesInOrderWithBoundVoices() async throws {
        let engine = RecordingEngine()
        let synthesizer = DialogueSynthesizer(engine: engine)
        let lines = [
            DialogueLine(role: nil, text: "深夜的茶馆。"),
            DialogueLine(role: "Vivian", text: "来了。"),
            DialogueLine(role: "Eric", text: "坐。"),
        ]

        var chunkMarkers: [Float] = []
        let stream = synthesizer.synthesize(
            lines: lines,
            bindings: ["Vivian": RoleBinding(voice: vivian), "Eric": RoleBinding(voice: eric)],
            narrator: RoleBinding(voice: narrator)
        )
        for try await chunk in stream {
            chunkMarkers.append(contentsOf: chunk.samples)
        }

        // chunk 到达顺序与台词段顺序一致
        #expect(chunkMarkers == [0, 1, 2])
        #expect(engine.calls == [
            RecordingEngine.Call(text: "深夜的茶馆。", voiceID: narrator.id, instruction: nil),
            RecordingEngine.Call(text: "来了。", voiceID: vivian.id, instruction: nil),
            RecordingEngine.Call(text: "坐。", voiceID: eric.id, instruction: nil),
        ])
    }

    @Test func cancellationDuringFirstLineSkipsRemainingLines() async throws {
        let engine = RecordingEngine(chunksPerCall: 10, chunkDelay: 0.05)
        let synthesizer = DialogueSynthesizer(engine: engine)
        let lines = [
            DialogueLine(role: "Vivian", text: "第一段很长。"),
            DialogueLine(role: "Eric", text: "永远不该被合成。"),
        ]

        let received = await Task {
            var count = 0
            do {
                let stream = synthesizer.synthesize(
                    lines: lines,
                    bindings: ["Vivian": RoleBinding(voice: vivian), "Eric": RoleBinding(voice: eric)],
                    narrator: RoleBinding(voice: narrator)
                )
                for try await _ in stream {
                    count += 1
                    if count == 2 {
                        withUnsafeCurrentTask { $0?.cancel() }
                    }
                }
            } catch {}
            return count
        }.value

        // 给已取消的内部 Task 留出结束时间，确认没有后续段被启动
        try await Task.sleep(for: .seconds(0.3))
        #expect(received < 10)
        #expect(engine.calls.map(\.text) == ["第一段很长。"], "取消后第二段不应被合成")
    }

    @Test func lineFailureTerminatesStreamWithError() async throws {
        let engine = RecordingEngine(failOnText: "会失败的段。")
        let synthesizer = DialogueSynthesizer(engine: engine)
        let lines = [
            DialogueLine(role: "Vivian", text: "正常的段。"),
            DialogueLine(role: "Eric", text: "会失败的段。"),
            DialogueLine(role: "Vivian", text: "不该到达的段。"),
        ]

        var receivedChunks = 0
        var thrown: Error?
        do {
            let stream = synthesizer.synthesize(
                lines: lines,
                bindings: ["Vivian": RoleBinding(voice: vivian), "Eric": RoleBinding(voice: eric)],
                narrator: RoleBinding(voice: narrator)
            )
            for try await _ in stream {
                receivedChunks += 1
            }
        } catch {
            thrown = error
        }

        #expect(receivedChunks == 1, "失败前的段应正常到达")
        #expect(thrown is InferenceError)
        #expect(engine.calls.map(\.text) == ["正常的段。", "会失败的段。"], "失败后不应继续后续段")
    }

    @Test func inlineInstructionOverridesGlobalAndClonedRolesStayGated() async throws {
        let engine = RecordingEngine()
        let synthesizer = DialogueSynthesizer(engine: engine)
        let clone = CloneReference(audioURL: URL(fileURLWithPath: "/tmp/ref.wav"), transcript: "参考文稿")
        let lines = [
            DialogueLine(role: "Vivian", text: "带行内指令。", instruction: "用愤怒的语气"),
            DialogueLine(role: "Vivian", text: "无行内指令。"),
            DialogueLine(role: "张三", text: "克隆角色带行内指令。", instruction: "小声点"),
        ]

        let stream = synthesizer.synthesize(
            lines: lines,
            bindings: [
                "Vivian": RoleBinding(voice: vivian, options: SynthesisOptions(instruction: "全局指令")),
                "张三": RoleBinding(voice: .default, options: SynthesisOptions(clone: clone)),
            ],
            narrator: RoleBinding(voice: narrator)
        )
        for try await _ in stream {}

        #expect(engine.calls.map(\.instruction) == [
            "用愤怒的语气", // 行内覆盖全局
            "全局指令",     // 无行内 → 用角色全局指令
            nil,            // 克隆角色：指令组合按 02 号门控，暂不传递
        ])
    }

    @Test func unboundRoleFailsBeforeAnySynthesis() async throws {
        let engine = RecordingEngine()
        let synthesizer = DialogueSynthesizer(engine: engine)
        let lines = [
            DialogueLine(role: "Vivian", text: "有绑定。"),
            DialogueLine(role: "神秘人", text: "没有绑定。"),
        ]

        var thrown: Error?
        do {
            let stream = synthesizer.synthesize(
                lines: lines,
                bindings: ["Vivian": RoleBinding(voice: vivian)],
                narrator: RoleBinding(voice: narrator)
            )
            for try await _ in stream {}
        } catch {
            thrown = error
        }

        guard case .unboundRole("神秘人")? = thrown as? DialogueError else {
            Issue.record("应抛出 DialogueError.unboundRole，实际 \(String(describing: thrown))")
            return
        }
        #expect(engine.calls.isEmpty, "校验应发生在任何合成开始之前")
    }
}
