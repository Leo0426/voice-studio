import Foundation

public enum OpenAISynthesisModel: String, CaseIterable, Sendable {
    case audio = "gpt-audio-1.5"
    case audioMini = "gpt-audio-mini"
    case speech = "gpt-4o-mini-tts"

    public var maximumTextLength: Int { self == .speech ? 4096 : 800 }
    public var label: String {
        switch self {
        case .audio: rawValue
        case .audioMini: "\(rawValue)（2027-01-20 停用）"
        case .speech: "\(rawValue)（2027-01-06 停用）"
        }
    }
}

public enum OpenAIAudioFormat: String, CaseIterable, Sendable {
    case wav, mp3, flac
}

public struct OpenAISynthesisOptions: Sendable {
    public var model: OpenAISynthesisModel = .audio
    public var format: OpenAIAudioFormat = .wav
    public var voice = "marin"
    public var customVoiceID: String?
    public var style = ""
    public var emotion = ""
    public var pace = ""
    public var accent = ""
    public var instructions = ""
    public var speed = 1.0

    public init() {}

    public var validationMessage: String? {
        if let id = customVoiceID {
            guard id.range(of: #"\Avoice_[A-Za-z0-9_-]{1,120}\z"#, options: .regularExpression) != nil else {
                return "请输入有效的自定义声音 ID，例如 voice_1234。"
            }
        } else if !OpenAISpeechClient.voices.contains(voice) {
            return "请选择可用的 OpenAI 音色。"
        }
        if [style, emotion, pace, accent].contains(where: { $0.unicodeScalars.count > 80 }) ||
            instructions.unicodeScalars.count > 1000 {
            return "单项朗读设置最多 80 个字符，补充指导最多 1000 个字符。"
        }
        if model == .speech && !(0.25...4.0).contains(speed) { return "语速须在 0.25 至 4 倍之间。" }
        return nil
    }

    var deliveryDirections: String {
        let fields = [("Style", style), ("Emotion", emotion), ("Pace", model == .speech ? "" : pace),
                      ("Accent", accent), ("Additional delivery directions", instructions)]
        return fields.compactMap { label, value in
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : "\(label): \(trimmed)"
        }.joined(separator: "\n")
    }
}

public struct OpenAITranscriptionOptions: Sendable {
    public var languages: [String]
    public var prompt: String
    public var keywords: [String]

    public init(languages: [String] = [], prompt: String = "", keywords: [String] = []) {
        self.languages = languages
        self.prompt = prompt
        self.keywords = keywords
    }

    public var validationMessage: String? {
        guard languages.count <= 16, languages.allSatisfy({ code in
            code.range(of: #"\A(?:[a-z]{2}|eng|spa|yue|cmn|zh-cn|zh-tw|zh-hk)\z"#, options: .regularExpression) != nil
        }) else { return "请输入最多 16 个支持的语言代码，例如 zh、en、ja。" }
        guard prompt.unicodeScalars.count <= 1000 else { return "转写背景最多 1000 个字符。" }
        guard keywords.count <= 64, keywords.allSatisfy({ keyword in
            !keyword.isEmpty && keyword.unicodeScalars.count <= 80 &&
                keyword.rangeOfCharacter(from: CharacterSet(charactersIn: "<>\r\n")) == nil
        }) else { return "最多 64 个关键词，每项限 80 个字符。请移除尖括号或换行。" }
        return nil
    }
}
