import Foundation

/// 对话脚本的最小合成单元：角色 + 文本。role 为 nil 表示旁白段。
public struct DialogueLine: Equatable, Sendable {
    public var role: String?
    public var text: String
    /// 行内风格指令（「角色名（用愤怒的语气）：台词」），仅作用于本段，优先于全局指令
    public var instruction: String?

    public init(role: String?, text: String, instruction: String? = nil) {
        self.role = role
        self.text = text
        self.instruction = instruction
    }
}

/// 对话脚本解析：纯文本行级标记「角色名：台词」→ 台词段（ADR-0002）。
public enum DialogueScript {
    /// 角色名长度上限：更长的冒号前缀视为台词内容（防「他说了很长一句话：…」误判）
    public static let maxRoleNameLength = 16
    /// 角色名不允许出现的标点：含句末标点的前缀是句子不是角色名
    private static let roleNameForbidden: Set<Character> = ["。", "！", "？", "!", "?", ".", ";", "；", "，", ","]

    public static func parse(_ text: String) -> [DialogueLine] {
        var lines: [DialogueLine] = []
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty else { continue }
            if let (role, instruction, dialogue) = splitRoleMarker(line) {
                if let last = lines.last, last.role == role, last.instruction == instruction {
                    // 连续同角色同指令的行合并为一段；指令不同则各自成段
                    lines[lines.count - 1].text += "\n" + dialogue
                } else {
                    lines.append(DialogueLine(role: role, text: dialogue, instruction: instruction))
                }
            } else if lines.isEmpty {
                // 开头的无标记行是旁白段
                lines.append(DialogueLine(role: nil, text: line))
            } else {
                // 无标记行归属上一段
                lines[lines.count - 1].text += "\n" + line
            }
        }
        return lines
    }

    /// 「角色名（行内指令）：台词」→ (角色名, 行内指令?, 台词)；不是角色标记时返回 nil
    private static func splitRoleMarker(_ line: String) -> (role: String, instruction: String?, dialogue: String)? {
        guard let colon = line.firstIndex(where: { $0 == "：" || $0 == ":" }) else { return nil }
        var role = String(line[line.startIndex ..< colon]).trimmingCharacters(in: .whitespaces)
        let dialogue = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)

        // 冒号前以括号收尾 → 括号内是本段的行内指令
        var instruction: String?
        if role.hasSuffix("）") || role.hasSuffix(")"),
           let open = role.firstIndex(where: { $0 == "（" || $0 == "(" }) {
            let inner = String(role[role.index(after: open)...].dropLast()).trimmingCharacters(in: .whitespaces)
            instruction = inner.isEmpty ? nil : inner
            role = String(role[..<open]).trimmingCharacters(in: .whitespaces)
        }

        guard !role.isEmpty,
              role.count <= maxRoleNameLength,
              !role.contains(where: { roleNameForbidden.contains($0) })
        else { return nil }
        return (role, instruction, dialogue)
    }
}

/// 一个角色的发声配置：音色 + 该角色的合成选项。
public struct RoleBinding: Sendable {
    public var voice: Voice
    public var options: SynthesisOptions

    public init(voice: Voice, options: SynthesisOptions = .default) {
        self.voice = voice
        self.options = options
    }
}

public enum DialogueError: LocalizedError, Equatable {
    /// 台词段的角色没有音色绑定。UI 应在合成前拦截；这里是契约兜底，防止静默错配音色。
    case unboundRole(String)

    public var errorDescription: String? {
        switch self {
        case .unboundRole(let role):
            return String(localized: "角色「\(role)」尚未绑定音色。")
        }
    }
}

/// 对话编排：逐段调用底层引擎，音频块按台词段顺序汇入同一条流。
/// 与 SegmentingEngine 同构的装饰器——InferenceEngine 契约零改动。
public struct DialogueSynthesizer: Sendable {
    private let engine: any InferenceEngine

    public init(engine: any InferenceEngine) {
        self.engine = engine
    }

    public func synthesize(
        lines: [DialogueLine],
        bindings: [String: RoleBinding],
        narrator: RoleBinding
    ) -> AsyncThrowingStream<AudioChunk, Error> {
        let engine = engine
        return AsyncThrowingStream { continuation in
            // 合成前整体校验绑定：错配音色的对话不如不开始
            if let unbound = lines.compactMap(\.role).first(where: { bindings[$0] == nil }) {
                continuation.finish(throwing: DialogueError.unboundRole(unbound))
                return
            }
            let task = Task {
                do {
                    for line in lines {
                        try Task.checkCancellation()
                        let binding = line.role.flatMap { bindings[$0] } ?? narrator
                        var options = binding.options
                        // 行内指令覆盖全局指令；克隆/设计音色与指令的组合按 02 号 spike 结论门控，暂不传递
                        if let lineInstruction = line.instruction, options.clone == nil, options.design == nil {
                            options.instruction = lineInstruction
                        }
                        for try await chunk in engine.synthesize(text: line.text, voice: binding.voice, options: options) {
                            continuation.yield(chunk)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }
}
