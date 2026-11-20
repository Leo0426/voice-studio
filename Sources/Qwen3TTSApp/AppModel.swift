import AppKit
import Carbon.HIToolbox
import Foundation
import Observation
import TTSCore
import TTSEngineMLX
import UniformTypeIdentifiers

/// 当前选中的发声方式：预置音色 / 克隆音色 / 语音设计
enum VoiceSelection: Hashable {
    case preset(String)
    case clone(UUID)
    case design(UUID)

    /// 稳定字符串编码：选择持久化与对话历史的角色绑定共用
    var encoded: String {
        switch self {
        case .preset(let id): return "preset:\(id)"
        case .clone(let id): return "clone:\(id.uuidString)"
        case .design(let id): return "design:\(id.uuidString)"
        }
    }

    init?(encoded: String) {
        if encoded.hasPrefix("preset:") {
            self = .preset(String(encoded.dropFirst("preset:".count)))
        } else if encoded.hasPrefix("clone:"),
                  let uuid = UUID(uuidString: String(encoded.dropFirst("clone:".count))) {
            self = .clone(uuid)
        } else if encoded.hasPrefix("design:"),
                  let uuid = UUID(uuidString: String(encoded.dropFirst("design:".count))) {
            self = .design(uuid)
        } else {
            return nil
        }
    }
}

/// 引擎槽位：每种发声方式对应一个模型（CustomVoice / Base / VoiceDesign 变体）
enum ModelSlotKind: CaseIterable, Hashable {
    case preset
    case clone
    case design

    var title: String {
        switch self {
        case .preset: return "预置音色模型"
        case .clone: return "克隆音色模型"
        case .design: return "语音设计模型"
        }
    }
}

/// 模型在内存中的加载状态（加载管理用）
enum ModelLoadState: Equatable {
    case unloaded
    case loading
    case loaded

    var label: String {
        switch self {
        case .unloaded: return "未加载"
        case .loading: return "加载中…"
        case .loaded: return "已加载（约 2 GB 内存）"
        }
    }
}

@MainActor
@Observable
final class AppModel {
    let deviceAccess: DeviceAccess
    var sheet: DeviceSheet?
    @ObservationIgnored private var modelTasks: [UUID: Task<Void, Never>] = [:]
    var text: String = ""
    var voiceSelection: VoiceSelection = .preset(Voice.default.id) {
        didSet {
            persistVoiceSelection()
            ensureActiveSlot()
        }
    }
    /// 风格指令（仅预置音色生效；克隆/设计的风格由参考音频或描述决定）
    var instruction: String = "" {
        didSet { defaults.set(instruction, forKey: "lastInstruction") }
    }
    /// 播放速度（变速不变调），跨会话记住
    var playbackRate: Float = 1.0 {
        didSet {
            player.rate = playbackRate
            defaults.set(Double(playbackRate), forKey: "playbackRate")
        }
    }
    let settings: AppSettings
    @ObservationIgnored private let defaults: UserDefaults

    private(set) var isSynthesizing = false
    private(set) var errorMessage: String?
    /// 错误源于所需模型未下载：错误提示旁直接给「去下载」入口
    private(set) var errorNeedsDownloadCenter = false
    /// 本次合成的首包延迟（可感知的“开始出声”时间）
    private(set) var firstChunkLatency: TimeInterval?

    let player = StreamingAudioPlayer()
    private let writeHistory: DeviceHistoryWriter
    private(set) var savingHistory = false
    private(set) var historyWarning: String?
    private var pendingHistory: [UUID: (DeviceSynthesisTask, DeviceSynthesisResult)] = [:]
    let clonedVoices: ClonedVoiceStore
    let designedVoices: DesignedVoiceStore
    let modelLibrary: ModelLibrary

    // 每个槽位一套 MLX 引擎与下载管理器，按需惰性创建；
    // QWEN3TTS_FAKE_ENGINE=1 时全部走假引擎跑 UI 快速内循环
    private var fakeEngine: (any InferenceEngine)?
    private var mlxEngines: [ModelSlotKind: MLXInferenceEngine] = [:]
    private var managers: [ModelSlotKind: MLXModelManager] = [:]
    private var loadStates: [ModelSlotKind: ModelLoadState] = [:]
    private var synthesisTask: Task<Void, Never>?
    private var isFakeMode: Bool { fakeEngine != nil }
    /// 全局快捷键（默认 ⌃⌥⌘S，设置可改）：朗读剪贴板 / 停止（开关语义）
    private var speakHotKey: GlobalHotKey?
    /// 快捷键注册失败（如与其他 App 冲突）时的设置页提示
    private(set) var speakShortcutFailed = false

    init(
        deviceAccess: DeviceAccess,
        writeHistory: @escaping DeviceHistoryWriter,
        voicesDirectory: URL? = nil,
        designsDirectory: URL? = nil,
        settings: AppSettings? = nil,
        defaults: UserDefaults = .standard,
        forceFakeEngine: Bool = false
    ) {
        self.deviceAccess = deviceAccess
        let settings = settings ?? AppSettings()
        self.settings = settings
        self.defaults = defaults
        self.writeHistory = writeHistory
        clonedVoices = ClonedVoiceStore(directory: voicesDirectory)
        designedVoices = DesignedVoiceStore(directory: designsDirectory)
        modelLibrary = ModelLibrary(
            cacheDirectory: settings.resolvedStorageURL,
            downloadHost: settings.resolvedDownloadHost
        )
        if forceFakeEngine || ProcessInfo.processInfo.environment["QWEN3TTS_FAKE_ENGINE"] == "1" {
            fakeEngine = SegmentingEngine(base: FakeInferenceEngine())
        } else {
            ensureSlot(.preset)
        }
        restoreVoiceSelection()
        instruction = defaults.string(forKey: "lastInstruction") ?? ""
        if let savedRate = defaults.object(forKey: "playbackRate") as? Double {
            playbackRate = Float(savedRate)
        }
        ensureActiveSlot()
        warmUpActiveEngineIfReady()
        applySpeakShortcut()
    }

    /// 按设置（重新）注册全局快捷键；旧注册先释放
    func applySpeakShortcut() {
        deviceAccess.perform { self.authorizedApplySpeakShortcut() }
    }

    private func authorizedApplySpeakShortcut() {
        speakHotKey = nil
        speakShortcutFailed = false
        let shortcut = settings.speakShortcut
        guard !shortcut.isDisabled else { return }
        speakHotKey = GlobalHotKey(
            keyCode: shortcut.keyCode,
            modifiers: shortcut.carbonModifiers
        ) { [weak self] in
            Task { @MainActor in
                self?.toggleSpeakClipboard()
            }
        }
        speakShortcutFailed = speakHotKey == nil
    }

    func present(_ sheet: DeviceSheet) { deviceAccess.perform { self.sheet = sheet } }

    func lockDevice() {
        deviceAccess.invalidate()
        speakHotKey = nil
        cancelSynthesis()
        player.stop()
        for task in modelTasks.values { task.cancel() }
        modelTasks.removeAll()
        sheet = nil
        text = ""
        roleBindings.removeAll()
        pendingHistory.removeAll()
        historyWarning = nil
    }

    func download(_ manager: MLXModelManager) {
        deviceAccess.perform { self.manageTask { await manager.download() } }
    }

    private func manageTask(_ operation: @escaping @MainActor () async -> Void) {
        guard deviceAccess.active else { return }
        let id = UUID()
        modelTasks[id] = Task {
            guard !Task.isCancelled else { return }
            await operation()
            modelTasks[id] = nil
        }
    }

    // MARK: - 错误提示

    func clearError() {
        errorMessage = nil
        errorNeedsDownloadCenter = false
    }

    private func reportError(_ message: String, needsDownloadCenter: Bool = false) {
        errorMessage = message
        errorNeedsDownloadCenter = needsDownloadCenter
    }

    // MARK: - 剪贴板朗读（菜单栏 / 全局快捷键）

    var isSpeaking: Bool {
        isSynthesizing || player.state == .playing
    }

    /// 开关语义：正在出声就停止，否则朗读剪贴板文本
    func toggleSpeakClipboard() {
        deviceAccess.perform { self.authorizedToggleSpeakClipboard() }
    }

    private func authorizedToggleSpeakClipboard() {
        if isSpeaking {
            cancelSynthesis()
            player.stop()
            return
        }
        guard let clipboard = NSPasteboard.general.string(forType: .string)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !clipboard.isEmpty else {
            NSSound.beep()
            return
        }
        text = clipboard
        synthesize()
    }

    // MARK: - 音色选择

    var activeSlot: ModelSlotKind {
        switch voiceSelection {
        case .preset: return .preset
        case .clone: return .clone
        case .design: return .design
        }
    }

    var usingClone: Bool { activeSlot == .clone }
    var usingDesign: Bool { activeSlot == .design }

    var selectedPresetVoice: Voice {
        if case .preset(let id) = voiceSelection,
           let preset = Voice.presets.first(where: { $0.id == id }) {
            return preset
        }
        return .default
    }

    var selectedClonedVoice: ClonedVoice? {
        guard case .clone(let id) = voiceSelection else { return nil }
        return clonedVoices.items.first { $0.id == id }
    }

    var selectedDesignedVoice: DesignedVoice? {
        guard case .design(let id) = voiceSelection else { return nil }
        return designedVoices.items.first { $0.id == id }
    }

    func addClonedVoice(name: String, transcript: String, sourceAudioURL: URL) {
        deviceAccess.perform { self.authorizedAddClonedVoice(name: name, transcript: transcript, sourceAudioURL: sourceAudioURL) }
    }

    private func authorizedAddClonedVoice(name: String, transcript: String, sourceAudioURL: URL) {
        do {
            let voice = try clonedVoices.add(name: name, transcript: transcript, sourceAudioURL: sourceAudioURL)
            voiceSelection = .clone(voice.id)
        } catch {
            reportError("克隆音色保存失败：\(error.localizedDescription)")
        }
    }

    func deleteClonedVoice(_ voice: ClonedVoice) {
        deviceAccess.perform { self.authorizedDeleteClonedVoice(voice) }
    }

    private func authorizedDeleteClonedVoice(_ voice: ClonedVoice) {
        clonedVoices.delete(voice)
        if case .clone(let id) = voiceSelection, id == voice.id {
            voiceSelection = .preset(Voice.default.id)
        }
    }

    func addDesignedVoice(name: String, prompt: String) {
        deviceAccess.perform { self.authorizedAddDesignedVoice(name: name, prompt: prompt) }
    }

    private func authorizedAddDesignedVoice(name: String, prompt: String) {
        let voice = designedVoices.add(name: name, prompt: prompt)
        voiceSelection = .design(voice.id)
    }

    func deleteDesignedVoice(_ voice: DesignedVoice) {
        deviceAccess.perform { self.authorizedDeleteDesignedVoice(voice) }
    }

    private func authorizedDeleteDesignedVoice(_ voice: DesignedVoice) {
        designedVoices.delete(voice)
        if case .design(let id) = voiceSelection, id == voice.id {
            voiceSelection = .preset(Voice.default.id)
        }
    }

    // MARK: - 对话模式（ADR-0002）

    /// 当前文本解析出的台词段；无角色标记时为单段旁白（走现状单音色路径）
    var dialogueLines: [DialogueLine] { DialogueScript.parse(text) }

    /// 检测到的角色（按出现顺序去重）
    var dialogueRoles: [String] {
        var seen = Set<String>()
        return dialogueLines.compactMap { line in
            guard let role = line.role, seen.insert(role).inserted else { return nil }
            return role
        }
    }

    var isDialogue: Bool { !dialogueRoles.isEmpty }

    /// 本场脚本的角色绑定（会话内）；持久化按角色名记忆，跨脚本复用
    private var roleBindings: [String: VoiceSelection] = [:]

    /// 角色的生效绑定：本场设置 > 按角色名记住的绑定 > 与预置音色同名的默认绑定
    func binding(for role: String) -> VoiceSelection? {
        if let bound = roleBindings[role], isValidSelection(bound) { return bound }
        if let saved = defaults.string(forKey: "roleBinding:\(role)"),
           let selection = VoiceSelection(encoded: saved), isValidSelection(selection) {
            return selection
        }
        if let preset = Voice.presets.first(where: {
            $0.id.caseInsensitiveCompare(role) == .orderedSame ||
                $0.displayName.caseInsensitiveCompare(role) == .orderedSame
        }) {
            return .preset(preset.id)
        }
        return nil
    }

    func setBinding(_ selection: VoiceSelection, for role: String) {
        deviceAccess.perform { self.authorizedSetBinding(selection, for: role) }
    }

    private func authorizedSetBinding(_ selection: VoiceSelection, for role: String) {
        roleBindings[role] = selection
        defaults.set(selection.encoded, forKey: "roleBinding:\(role)")
        if let slot = dialogueSlot { ensureSlot(slot) }
    }

    /// 绑定指向的音色是否仍存在（克隆/设计音色可能已被删除）
    private func isValidSelection(_ selection: VoiceSelection) -> Bool {
        switch selection {
        case .preset(let id): return Voice.presets.contains { $0.id == id }
        case .clone(let id): return clonedVoices.items.contains { $0.id == id }
        case .design(let id): return designedVoices.items.contains { $0.id == id }
        }
    }

    private func slotKind(of selection: VoiceSelection) -> ModelSlotKind {
        switch selection {
        case .preset: return .preset
        case .clone: return .clone
        case .design: return .design
        }
    }

    var dialogueUnboundRoles: [String] {
        dialogueRoles.filter { binding(for: $0) == nil }
    }

    /// 有旁白段时旁白使用主音色，参与变体一致性校验
    var dialogueHasNarration: Bool {
        isDialogue && dialogueLines.contains { $0.role == nil }
    }

    /// 全场统一的模型槽位；混用变体时为 nil（ADR-0002 单变体边界）
    var dialogueSlot: ModelSlotKind? {
        var slots = Set(dialogueRoles.compactMap { binding(for: $0).map(slotKind(of:)) })
        if dialogueHasNarration { slots.insert(slotKind(of: voiceSelection)) }
        return slots.count == 1 ? slots.first : nil
    }

    /// 绑定面板的校验提示；nil 即可合成
    var dialogueValidationMessage: String? {
        guard isDialogue else { return nil }
        let unbound = dialogueUnboundRoles
        if !unbound.isEmpty {
            return "未绑定音色：\(unbound.joined(separator: "、"))"
        }
        if dialogueSlot == nil {
            return "一场对话只能使用同一类音色（预置 / 克隆 / 设计不可混用；旁白跟随主音色）"
        }
        return nil
    }

    /// 一个发声选择 → 对话角色的 RoleBinding；音色已被删除时返回 nil
    private func makeRoleBinding(_ selection: VoiceSelection) -> RoleBinding? {
        switch selection {
        case .preset(let id):
            guard let voice = Voice.presets.first(where: { $0.id == id }) else { return nil }
            return RoleBinding(voice: voice, options: settings.makeSynthesisOptions(instruction: instruction))
        case .clone(let id):
            guard let cloned = clonedVoices.items.first(where: { $0.id == id }) else { return nil }
            return RoleBinding(
                voice: .default,
                options: settings.makeSynthesisOptions(instruction: instruction, clone: clonedVoices.cloneReference(for: cloned))
            )
        case .design(let id):
            guard let designed = designedVoices.items.first(where: { $0.id == id }) else { return nil }
            return RoleBinding(voice: .default, options: settings.makeSynthesisOptions(instruction: "", design: designed.prompt))
        }
    }

    // MARK: - 槽位与模型就绪

    func repo(for kind: ModelSlotKind) -> String {
        switch kind {
        case .preset: return settings.modelRepo
        case .clone: return settings.baseModelRepo
        case .design: return AppSettings.designModelRepo
        }
    }

    /// 惰性创建槽位的引擎与管理器
    private func ensureSlot(_ kind: ModelSlotKind) {
        guard !isFakeMode, mlxEngines[kind] == nil else { return }
        let repo = repo(for: kind)
        mlxEngines[kind] = MLXInferenceEngine(modelRepo: repo, cacheDirectory: settings.resolvedStorageURL)
        managers[kind] = modelLibrary.manager(for: repo)
        loadStates[kind] = .unloaded
    }

    private func ensureActiveSlot() {
        guard !isFakeMode else { return }
        ensureSlot(activeSlot)
        warmUpActiveEngineIfReady()
    }

    /// 当前发声方式所需的模型管理器（引导页/工具栏面板/设置均随之切换）
    var modelManager: MLXModelManager? {
        managers[activeSlot]
    }

    /// 设置页加载管理用：已创建的槽位
    var activeSlots: [ModelSlotKind] {
        ModelSlotKind.allCases.filter { managers[$0] != nil }
    }

    func slotManager(_ kind: ModelSlotKind) -> MLXModelManager? {
        managers[kind]
    }

    var isModelReady: Bool {
        if isFakeMode { return true }
        return modelManager?.state == .ready
    }

    func downloadModel() {
        deviceAccess.perform { self.authorizedDownloadModel() }
    }

    private func authorizedDownloadModel() {
        guard let manager = modelManager else { return }
        manageTask {
            await manager.download()
            guard !Task.isCancelled else { return }
            self.warmUpActiveEngineIfReady()
        }
    }

    /// 设置里切换模型规格后重建全部槽位；未下载时引导页自然出现
    func applyModelSelection() {
        deviceAccess.perform { self.authorizedApplyModelSelection() }
    }

    private func authorizedApplyModelSelection() {
        guard !isFakeMode, mlxEngines[.preset]?.modelRepo != settings.modelRepo else { return }
        rebuildEngines()
    }

    /// 设置里改下载源后同步到全部管理器（对下一次下载生效）
    func applyDownloadSource() {
        deviceAccess.perform { self.authorizedApplyDownloadSource() }
    }

    private func authorizedApplyDownloadSource() {
        modelLibrary.setDownloadHost(settings.resolvedDownloadHost)
    }

    /// 更改模型存储路径：管理器与引擎全部重建（不迁移已下载文件）
    func applyStorageDirectory() {
        deviceAccess.perform { self.authorizedApplyStorageDirectory() }
    }

    private func authorizedApplyStorageDirectory() {
        guard !isFakeMode else { return }
        modelLibrary.setCacheDirectory(settings.resolvedStorageURL)
        rebuildEngines()
    }

    private func rebuildEngines() {
        guard !isFakeMode else { return }
        mlxEngines = [:]
        managers = [:]
        loadStates = [:]
        ensureSlot(.preset)
        ensureActiveSlot()
        warmUpActiveEngineIfReady()
    }

    // MARK: - 加载管理

    /// 当前所需模型就绪后按设置自动预热，首次合成不吃加载延迟
    private func warmUpActiveEngineIfReady() {
        guard settings.autoWarmUp else { return }
        warmUpModel(activeSlot)
    }

    /// 手动/自动把模型加载进内存
    func warmUpModel(_ kind: ModelSlotKind) {
        deviceAccess.perform { self.authorizedWarmUpModel(kind) }
    }

    private func authorizedWarmUpModel(_ kind: ModelSlotKind) {
        guard let engine = mlxEngines[kind], managers[kind]?.state == .ready,
              loadState(kind) == .unloaded else { return }
        loadStates[kind] = .loading
        manageTask { [weak self] in
            do {
                try await engine.prepare()
                try Task.checkCancellation()
                self?.loadStates[kind] = .loaded
            } catch {
                self?.loadStates[kind] = .unloaded
                self?.reportError("模型加载失败：\(error.localizedDescription)")
            }
        }
    }

    /// 卸载模型释放内存；下次合成会重新加载
    func unloadModel(_ kind: ModelSlotKind) {
        deviceAccess.perform { self.authorizedUnloadModel(kind) }
    }

    private func authorizedUnloadModel(_ kind: ModelSlotKind) {
        guard !isSynthesizing, let engine = mlxEngines[kind] else { return }
        manageTask { [weak self] in
            await engine.unload()
            self?.loadStates[kind] = .unloaded
        }
    }

    func loadState(_ kind: ModelSlotKind) -> ModelLoadState {
        loadStates[kind] ?? .unloaded
    }

    // MARK: - 合成

    var canSynthesize: Bool {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !isSynthesizing, !savingHistory else { return false }
        if isDialogue {
            // 模型就绪在 synthesizeDialogue 里检查（未就绪给「去下载」提示）
            return dialogueValidationMessage == nil
        }
        guard isModelReady else { return false }
        if usingClone, selectedClonedVoice == nil { return false }
        if usingDesign, selectedDesignedVoice == nil { return false }
        return true
    }

    var hasAudio: Bool {
        !player.samples.isEmpty && !isSynthesizing
    }

    func synthesize() {
        deviceAccess.perform { self.authorizedSynthesize() }
    }

    private func authorizedSynthesize() {
        guard canSynthesize else { return }
        if isDialogue {
            synthesizeDialogue()
            return
        }
        let historyVoiceID: String
        switch voiceSelection {
        case .preset: historyVoiceID = selectedPresetVoice.id
        case .clone: historyVoiceID = selectedClonedVoice?.name ?? "克隆音色"
        case .design: historyVoiceID = selectedDesignedVoice?.name ?? "设计音色"
        }
        let options = settings.makeSynthesisOptions(
            instruction: instruction,
            clone: selectedClonedVoice.map { clonedVoices.cloneReference(for: $0) },
            design: selectedDesignedVoice?.prompt
        )
        startSynthesis(
            text: text,
            voice: selectedPresetVoice,
            options: options,
            slot: activeSlot,
            historyVoiceID: historyVoiceID
        )
    }

    /// 对话合成：解析出的台词段 + 角色绑定 → DialogueSynthesizer 编排
    private func synthesizeDialogue() {
        let lines = dialogueLines
        var bindings: [String: RoleBinding] = [:]
        for role in dialogueRoles {
            guard let selection = binding(for: role), let roleBinding = makeRoleBinding(selection) else {
                reportError("角色「\(role)」尚未绑定音色。")
                return
            }
            bindings[role] = roleBinding
        }
        guard let slot = dialogueSlot else {
            reportError("一场对话只能使用同一类音色（预置 / 克隆 / 设计不可混用）。")
            return
        }
        // 旁白跟随主音色；主音色不可用（如克隆已删）时回落默认预置
        let narrator = makeRoleBinding(voiceSelection)
            ?? RoleBinding(voice: .default, options: settings.makeSynthesisOptions(instruction: instruction))
        ensureSlot(slot)
        if !isFakeMode, managers[slot]?.state != .ready {
            reportError("对话使用的「\(slot.title)」尚未下载", needsDownloadCenter: true)
            return
        }
        startSynthesis(
            slot: slot,
            historyText: text,
            historyVoiceID: "对话 · \(dialogueRoles.count) 角色"
        ) { engine in
            DialogueSynthesizer(engine: engine).synthesize(lines: lines, bindings: bindings, narrator: narrator)
        }
    }

    /// 试听一段声音描述（语音设计面板用）：固定示例句，不进历史
    static let auditionSampleText = "你好，这就是用这段描述生成的声音。今天天气不错，适合出去走走。"

    func toggleAuditionDesign(prompt: String) {
        deviceAccess.perform { self.authorizedToggleAuditionDesign(prompt: prompt) }
    }

    private func authorizedToggleAuditionDesign(prompt: String) {
        if isSpeaking {
            cancelSynthesis()
            player.stop()
            return
        }
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        ensureSlot(.design)
        if !isFakeMode, managers[.design]?.state != .ready {
            reportError("试听需要先下载「语音设计 1.7B」模型", needsDownloadCenter: true)
            return
        }
        let options = settings.makeSynthesisOptions(instruction: "", design: trimmed)
        startSynthesis(
            text: Self.auditionSampleText,
            voice: .default,
            options: options,
            slot: .design,
            historyVoiceID: nil
        )
    }

    /// 单音色合成（正式合成与试听共用）
    private func startSynthesis(
        text inputText: String,
        voice inputVoice: Voice,
        options: SynthesisOptions,
        slot: ModelSlotKind,
        historyVoiceID: String?
    ) {
        startSynthesis(slot: slot, historyText: inputText, historyVoiceID: historyVoiceID) { engine in
            engine.synthesize(text: inputText, voice: inputVoice, options: options)
        }
    }

    /// 合成执行器：单音色、试听与对话共用同一条流消费链路
    private func startSynthesis(
        slot: ModelSlotKind,
        historyText: String?,
        historyVoiceID: String?,
        makeStream: @escaping (any InferenceEngine) -> AsyncThrowingStream<AudioChunk, Error>
    ) {
        let activeEngine: any InferenceEngine = fakeEngine
            ?? mlxEngines[slot].map { SegmentingEngine(base: $0) }
            ?? SegmentingEngine(base: FakeInferenceEngine())
        clearError()
        firstChunkLatency = nil
        isSynthesizing = true

        let entry = historyText.flatMap { text in historyVoiceID.map { DeviceSynthesisTask(text: text, voice: $0) } }
        synthesisTask = Task {
            let result: DeviceSynthesisResult
            let started = ContinuousClock.now
            do {
                try Task.checkCancellation()
                try player.beginStreaming(sampleRate: 24_000)
                for try await chunk in makeStream(activeEngine) {
                    try Task.checkCancellation()
                    if firstChunkLatency == nil {
                        firstChunkLatency = started.duration(to: .now).seconds
                        // 合成会隐式加载模型，同步到加载管理状态
                        if !isFakeMode { loadStates[slot] = .loaded }
                    }
                    player.enqueue(chunk)
                }
                try Task.checkCancellation()
                player.endStreaming()
                result = .completed(samples: player.samples, rate: player.sampleRate)
            } catch is CancellationError {
                player.endStreaming()
                result = .cancelled
            } catch {
                player.stop()
                reportError(error.localizedDescription)
                result = .failed
            }
            synthesisTask = nil
            if let entry {
                savingHistory = true
                // 取消推理仍需提交取消状态，使用独立的写任务和起始账号的凭据。
                await Task { await self.archive(entry, result) }.value
                savingHistory = false
            }
            isSynthesizing = false
        }
    }

    func cancelSynthesis() {
        synthesisTask?.cancel()
        synthesisTask = nil
    }

    // MARK: - 播放与历史

    func replay() {
        deviceAccess.perform {
            do { try self.player.replay() } catch { self.reportError(error.localizedDescription) }
        }
    }

    // MARK: - 导出

    /// 导出当前播放器里的音频
    func exportCurrentAudio() {
        deviceAccess.perform {
            guard let url = self.askSaveDestination() else { return }
            self.deviceAccess.perform { self.writeCurrentAudio(to: url) }
        }
    }

    private func writeCurrentAudio(to url: URL) {
        do {
            try writeAudio(samples: player.samples, sampleRate: player.sampleRate, to: url)
        } catch {
            reportError(error.localizedDescription)
        }
    }

    /// 按目标扩展名选择编码：.m4a → AAC，其余 → WAV
    private func writeAudio(samples: [Float], sampleRate: Double, to url: URL) throws {
        if url.pathExtension.lowercased() == "m4a" {
            try M4AFile.write(samples: samples, sampleRate: sampleRate, to: url)
        } else {
            try WavFile.write(samples: samples, sampleRate: sampleRate, to: url)
        }
    }

    private func askSaveDestination() -> URL? {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.wav, .mpeg4Audio]
        // macOS 14 无格式下拉，直接改文件名后缀同样生效
        if #available(macOS 15, *) {
            panel.showsContentTypes = true
        }
        panel.nameFieldStringValue = "qwen3-tts-\(Self.fileTimestamp()).wav"
        guard panel.runModal() == .OK else { return nil }
        return panel.url
    }

    private func archive(_ task: DeviceSynthesisTask, _ result: DeviceSynthesisResult) async {
        do {
            try await writeHistory(task, result)
            pendingHistory[task.id] = nil
            if pendingHistory.isEmpty { historyWarning = nil }
        } catch {
            guard deviceAccess.active else { return }
            pendingHistory[task.id] = (task, result)
            historyWarning = "任务历史保存失败：" + error.localizedDescription
        }
    }

    func retrySavingHistory() {
        deviceAccess.perform {
            guard !self.isSynthesizing, !self.savingHistory, !self.pendingHistory.isEmpty else { return }
            let entries = Array(self.pendingHistory.values)
            self.savingHistory = true
            Task {
                for (task, result) in entries {
                    guard self.deviceAccess.active else { break }
                    await self.archive(task, result)
                }
                self.savingHistory = false
            }
        }
    }

    // MARK: - 选择持久化

    private func persistVoiceSelection() {
        defaults.set(voiceSelection.encoded, forKey: "lastVoiceSelection")
    }

    private func restoreVoiceSelection() {
        guard let saved = defaults.string(forKey: "lastVoiceSelection"),
              let selection = VoiceSelection(encoded: saved),
              isValidSelection(selection) else { return }
        voiceSelection = selection
    }

    private static func fileTimestamp() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter.string(from: .now)
    }
}

extension Duration {
    var seconds: TimeInterval {
        Double(components.seconds) + Double(components.attoseconds) / 1e18
    }
}
