import Foundation
import Testing
import TTSCore
@testable import Qwen3TTSApp

/// AppModel 状态机测试：全程 FakeInferenceEngine，隔离的 UserDefaults 与临时目录。
@MainActor
struct AppModelTests {
    private actor HistorySpy {
        var records: [(task: DeviceSynthesisTask, result: DeviceSynthesisResult)] = []
        func save(_ task: DeviceSynthesisTask, _ result: DeviceSynthesisResult) { records.append((task, result)) }
    }

    private func makeModel(access: DeviceAccess? = nil, history: HistorySpy = HistorySpy()) -> (model: AppModel, cleanup: () -> Void) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("AppModelTests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let suiteName = "AppModelTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        // 测试进程不注册全局快捷键，避免与正在运行的 App 冲突
        defaults.set("none", forKey: "speakShortcutID")
        let model = AppModel(
            deviceAccess: access ?? DeviceAccess { $0(true) },
            writeHistory: { await history.save($0, $1) },
            voicesDirectory: dir.appendingPathComponent("voices"),
            designsDirectory: dir.appendingPathComponent("designs"),
            settings: AppSettings(defaults: defaults),
            defaults: defaults,
            forceFakeEngine: true
        )
        return (model, {
            model.player.stop()
            defaults.removePersistentDomain(forName: suiteName)
            try? FileManager.default.removeItem(at: dir)
        })
    }

    /// 轮询等待合成结束（假引擎 1 秒起步，2× 实时产出）
    private func waitUntilIdle(_ model: AppModel, timeout: TimeInterval = 10) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while model.isSynthesizing {
            try await Task.sleep(for: .milliseconds(50))
            #expect(Date() < deadline, "合成超时未结束")
            if Date() >= deadline { return }
        }
    }

    @Test func revokedDeviceCannotSynthesizeOrSaveVoices() async throws {
        var allowed = true
        let access = DeviceAccess { $0(allowed) }
        let history = HistorySpy()
        let (model, clean) = makeModel(access: access, history: history)
        defer { clean() }
        model.text = "授权时创建的录音"
        model.synthesize()
        while model.isSynthesizing { try await Task.sleep(for: .milliseconds(10)) }
        allowed = false
        model.addDesignedVoice(name: "拒绝", prompt: "示例")
        model.synthesize()
        #expect(await history.records.count == 1)
        #expect(model.designedVoices.items.isEmpty)
        #expect(!model.isSynthesizing)
        model.lockDevice()
        #expect(model.text.isEmpty)
        #expect(model.sheet == nil)
    }

    @Test func synthesizeRunsStateMachineAndSavesHistory() async throws {
        let history = HistorySpy()
        let (model, cleanup) = makeModel(history: history)
        defer { cleanup() }
        model.text = "你好"

        #expect(model.canSynthesize)
        model.synthesize()
        #expect(model.isSynthesizing)
        #expect(!model.canSynthesize) // 合成中不可重入

        try await waitUntilIdle(model)
        #expect(model.errorMessage == nil)
        #expect(model.firstChunkLatency != nil)
        #expect(!model.player.samples.isEmpty)
        #expect(await history.records.count == 1)
        #expect(await history.records.first?.task.label.contains("你好") == true)
        #expect(await history.records.first?.result.status == "completed")
    }

    @Test func emptyTextCannotSynthesize() {
        let (model, cleanup) = makeModel()
        defer { cleanup() }
        model.text = "   "
        #expect(!model.canSynthesize)
    }

    @Test func cancelStopsSynthesis() async throws {
        let history = HistorySpy()
        let (model, cleanup) = makeModel(history: history)
        defer { cleanup() }
        model.text = String(repeating: "长文本测试。", count: 40)
        model.synthesize()
        #expect(model.isSynthesizing)

        model.cancelSynthesis()
        try await waitUntilIdle(model)
        // 取消不算错误
        #expect(model.errorMessage == nil)
        // 取消单独存状态，无残缺音频。
        #expect(await history.records.map { $0.result.status } == ["cancelled"])
    }

    @Test func auditionTogglesSpeakingWithoutHistory() async throws {
        let history = HistorySpy()
        let (model, cleanup) = makeModel(history: history)
        defer { cleanup() }
        model.toggleAuditionDesign(prompt: "低沉磁性的男声")
        #expect(model.isSynthesizing)

        try await waitUntilIdle(model)
        #expect(model.errorMessage == nil)
        // 试听不进历史
        #expect(await history.records.isEmpty)

        // 出声期间再次 toggle = 停止
        if model.isSpeaking {
            model.toggleAuditionDesign(prompt: "低沉磁性的男声")
            #expect(!model.isSpeaking)
        }
    }

    @Test func failedCloneReportsErrorAndClearErrorResets() {
        let (model, cleanup) = makeModel()
        defer { cleanup() }
        // 源文件不存在 → 保存失败 → 错误提示
        model.addClonedVoice(
            name: "坏音色",
            transcript: "文稿",
            sourceAudioURL: URL(fileURLWithPath: "/nonexistent/audio.wav")
        )
        #expect(model.errorMessage != nil)

        model.clearError()
        #expect(model.errorMessage == nil)
        #expect(!model.errorNeedsDownloadCenter)
    }

    @Test func newSynthesisClearsPreviousError() async throws {
        let (model, cleanup) = makeModel()
        defer { cleanup() }
        model.addClonedVoice(
            name: "坏音色",
            transcript: "文稿",
            sourceAudioURL: URL(fileURLWithPath: "/nonexistent/audio.wav")
        )
        #expect(model.errorMessage != nil)

        model.text = "你好"
        model.synthesize()
        #expect(model.errorMessage == nil) // 开始合成即清除旧错误
        try await waitUntilIdle(model)
    }

    // MARK: - 对话模式

    /// 造一个可被 ClonedVoiceStore 拷贝的假参考音频文件
    private func makeAudioFixture() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("fixture-\(UUID().uuidString).wav")
        try? Data([0x52, 0x49, 0x46, 0x46]).write(to: url)
        return url
    }

    @Test func dialogueDetectsRolesAndDefaultBindsPresets() {
        let (model, cleanup) = makeModel()
        defer { cleanup() }
        model.text = "开场旁白。\nVivian：你好。\nEric：吃了吗？\nVivian：吃过了。"

        #expect(model.isDialogue)
        #expect(model.dialogueRoles == ["Vivian", "Eric"])
        #expect(model.dialogueHasNarration)
        // 与预置音色同名 → 默认绑定
        #expect(model.binding(for: "Vivian") == .preset("Vivian"))
        #expect(model.binding(for: "Eric") == .preset("Eric"))
        #expect(model.dialogueValidationMessage == nil)
        #expect(model.canSynthesize)
    }

    @Test func plainTextIsNotDialogue() {
        let (model, cleanup) = makeModel()
        defer { cleanup() }
        model.text = "没有任何角色标记的普通文本。"
        #expect(!model.isDialogue)
        #expect(model.canSynthesize)
    }

    @Test func unboundRoleBlocksDialogueSynthesis() {
        let (model, cleanup) = makeModel()
        defer { cleanup() }
        model.text = "神秘人：我是谁？\nVivian：不知道。"

        #expect(model.binding(for: "神秘人") == nil)
        #expect(model.dialogueUnboundRoles == ["神秘人"])
        #expect(model.dialogueValidationMessage?.contains("神秘人") == true)
        #expect(!model.canSynthesize)

        // 绑定后解除
        model.setBinding(.preset("Serena"), for: "神秘人")
        #expect(model.dialogueValidationMessage == nil)
        #expect(model.canSynthesize)
    }

    @Test func dialogueSynthesizesStreamAndSavesOneHistory() async throws {
        let history = HistorySpy()
        let (model, cleanup) = makeModel(history: history)
        defer { cleanup() }
        model.text = "Vivian：你好。\nEric：吃了吗？"

        model.synthesize()
        #expect(model.isSynthesizing)
        try await waitUntilIdle(model)

        #expect(model.errorMessage == nil)
        #expect(!model.player.samples.isEmpty)
        #expect(await history.records.count == 1)
        #expect(await history.records.first?.task.label.contains("对话") == true)
    }

    @Test func mixedVariantDialogueIsBlocked() {
        let (model, cleanup) = makeModel()
        defer { cleanup() }
        let fixture = makeAudioFixture()
        defer { try? FileManager.default.removeItem(at: fixture) }
        model.addClonedVoice(name: "我的克隆", transcript: "文稿", sourceAudioURL: fixture)
        guard let cloned = model.clonedVoices.items.first else {
            Issue.record("克隆音色未保存")
            return
        }

        model.text = "Vivian：预置。\n张三：克隆。"
        model.setBinding(.clone(cloned.id), for: "张三")

        #expect(model.dialogueSlot == nil)
        #expect(model.dialogueValidationMessage?.contains("同一类音色") == true)
        #expect(!model.canSynthesize)

        // 全部换成克隆 → 恢复可合成（无旁白段，主音色不参与）
        model.setBinding(.clone(cloned.id), for: "Vivian")
        #expect(model.dialogueSlot == .clone)
        #expect(model.dialogueValidationMessage == nil)
        #expect(model.canSynthesize)
    }

    @Test func roleBindingPersistsAcrossInstances() {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("AppModelTests-binding-\(UUID().uuidString)", isDirectory: true)
        let suiteName = "AppModelTests-binding-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.set("none", forKey: "speakShortcutID")
        defer {
            defaults.removePersistentDomain(forName: suiteName)
            try? FileManager.default.removeItem(at: dir)
        }
        func make() -> AppModel {
            AppModel(
                deviceAccess: DeviceAccess { $0(true) },
                writeHistory: { _, _ in },
                voicesDirectory: dir.appendingPathComponent("voices"),
                designsDirectory: dir.appendingPathComponent("designs"),
                settings: AppSettings(defaults: defaults),
                defaults: defaults,
                forceFakeEngine: true
            )
        }

        let first = make()
        first.setBinding(.preset("Sohee"), for: "神秘人")

        let second = make()
        #expect(second.binding(for: "神秘人") == .preset("Sohee"))
    }

    @Test func deletedCloneBindingResolvesToNil() {
        let (model, cleanup) = makeModel()
        defer { cleanup() }
        let fixture = makeAudioFixture()
        defer { try? FileManager.default.removeItem(at: fixture) }
        model.addClonedVoice(name: "将被删除", transcript: "文稿", sourceAudioURL: fixture)
        guard let cloned = model.clonedVoices.items.first else {
            Issue.record("克隆音色未保存")
            return
        }
        model.setBinding(.clone(cloned.id), for: "张三")
        model.deleteClonedVoice(cloned)

        // 绑定指向已删除的音色 → 视为未绑定，而不是错配
        #expect(model.binding(for: "张三") == nil)
    }

    @Test func voiceSelectionPersistsAcrossInstances() {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("AppModelTests-persist-\(UUID().uuidString)", isDirectory: true)
        let suiteName = "AppModelTests-persist-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.set("none", forKey: "speakShortcutID")
        defer {
            defaults.removePersistentDomain(forName: suiteName)
            try? FileManager.default.removeItem(at: dir)
        }
        func make() -> AppModel {
            AppModel(
                deviceAccess: DeviceAccess { $0(true) },
                writeHistory: { _, _ in },
                voicesDirectory: dir.appendingPathComponent("voices"),
                designsDirectory: dir.appendingPathComponent("designs"),
                settings: AppSettings(defaults: defaults),
                defaults: defaults,
                forceFakeEngine: true
            )
        }

        let first = make()
        let target = Voice.presets[2].id
        first.voiceSelection = .preset(target)

        let second = make()
        #expect(second.voiceSelection == .preset(target))
    }
}
