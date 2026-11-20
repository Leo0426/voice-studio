import AVFoundation
import Foundation

enum AudioUploadEndpoint: String {
    case transcription = "audio/transcriptions"
    case consent = "audio/voice_consents"
    case voice = "audio/voices"

    var isEnrollment: Bool { self != .transcription }
    var sizeMessage: String { isEnrollment ? "每段录音最大 10 MiB。" : "OpenAI 转写支持最大 25 MB 的文件。" }
    var fileField: String {
        switch self {
        case .transcription: "file"
        case .consent: "recording"
        case .voice: "audio_sample"
        }
    }
}

extension OpenAISpeechClient {
    public static let maximumEnrollmentAudioBytes = 10 * 1024 * 1024
    private static let enrollmentTypes = ["mp3": "audio/mpeg", "mpeg": "audio/mpeg", "wav": "audio/wav",
                                          "ogg": "audio/ogg", "aac": "audio/aac", "flac": "audio/flac",
                                          "webm": "audio/webm", "mp4": "audio/mp4", "m4a": "audio/mp4"]
    public static var enrollmentAudioExtensions: [String] { enrollmentTypes.keys.sorted() }

    public func uploadVoiceConsent(name: String, language: String, recordingURL: URL) async throws -> String {
        guard ["en", "zh"].contains(language) else { throw SpeechError("请选择授权声明使用的语言。") }
        let fields = [("name", try Self.enrollmentName(name)), ("language", language)]
        let response = try await upload(recordingURL, to: .consent, fields: fields)
        return try Self.enrollmentID(in: response, isConsent: true)
    }

    public func createVoice(name: String, consentID: String, sampleURL: URL) async throws -> String {
        let consent = consentID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.validEnrollmentID(consent, isConsent: true) else {
            throw SpeechError("请先上传本人授权录音，或填写同一项目的授权 ID。")
        }
        let fields = [("name", try Self.enrollmentName(name)), ("consent", consent), ("type", "audio_sample")]
        let response = try await upload(sampleURL, to: .voice, fields: fields)
        return try Self.enrollmentID(in: response, isConsent: false)
    }

    private static func enrollmentName(_ raw: String) throws -> String {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.unicodeScalars.count <= 256 else { throw SpeechError("请填写 1 至 256 个字符的音色名称。") }
        return name
    }

    private static func validEnrollmentID(_ id: String, isConsent: Bool) -> Bool {
        let pattern = isConsent ? #"\Acons_[A-Za-z0-9_-]{1,200}\z"# : #"\Avoice_[A-Za-z0-9_-]{1,120}\z"#
        return id.range(of: pattern, options: .regularExpression) != nil
    }

    private static func enrollmentID(in response: Data, isConsent: Bool) throws -> String {
        struct Resource: Decodable {
            let id: String
            let object: String?
            let type: String?
        }
        let expectedObject = isConsent ? "audio.voice_consent" : "audio.voice"
        guard let result = try? JSONDecoder().decode(Resource.self, from: response),
              validEnrollmentID(result.id, isConsent: isConsent),
              result.object == nil || result.object == expectedObject,
              isConsent || result.type == nil || result.type == "audio_sample" else {
            throw SpeechError("OpenAI 未返回有效的 ID，请先在 OpenAI 音色管理页核对创建结果。")
        }
        return result.id
    }

    func upload(_ fileURL: URL, to endpoint: AudioUploadEndpoint, fields: [(String, String)]) async throws -> Data {
        let ext = fileURL.pathExtension.lowercased()
        let types = endpoint.isEnrollment ? Self.enrollmentTypes : Self.audioTypes
        guard fileURL.isFileURL, let mime = types[ext] else {
            throw SpeechError("OpenAI 不支持此文件格式，可使用 WAV、MP3 或 M4A。")
        }
        let boundary = "VoiceStudio-\(UUID().uuidString)"
        var request = try makeRequest(path: endpoint.rawValue, contentType: "multipart/form-data; boundary=\(boundary)")
        let info = try fileURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard info.isRegularFile == true, let size = info.fileSize, size > 0 else {
            throw SpeechError("请选择包含声音的音频文件。")
        }
        let limit = endpoint.isEnrollment ? Self.maximumEnrollmentAudioBytes : Self.maximumAudioBytes
        guard size <= limit else { throw SpeechError(endpoint.sizeMessage) }
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        guard let audio = try handle.read(upToCount: limit + 1), audio.count == size else {
            throw SpeechError("文件内容已更改，请重新选择。")
        }
        if endpoint.isEnrollment && !Self.matchesRecordingHeader(audio, mime: mime) {
            throw SpeechError("录音内容与文件格式不符，请重新选择或导出音频。")
        }
        if endpoint == .voice, let time = try? await AVURLAsset(url: fileURL).load(.duration),
           time.isNumeric, !(5...60).contains(time.seconds) {
            throw SpeechError("样本应含至少 5 秒人声，总时长不能超过 60 秒。")
        }
        try Task.checkCancellation()
        var body = Data()
        for (field, value) in fields {
            body.append(contentsOf: "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(field)\"\r\n\r\n\(value)\r\n".utf8)
        }
        let stem = endpoint.isEnrollment ? "recording" : "audio"
        body.append(contentsOf: "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(endpoint.fileField)\"; filename=\"\(stem).\(ext)\"\r\nContent-Type: \(mime)\r\n\r\n".utf8)
        body.append(audio)
        body.append(contentsOf: "\r\n--\(boundary)--\r\n".utf8)
        request.httpBody = body
        return try await perform(request, upload: endpoint)
    }

    private static func matchesRecordingHeader(_ bytes: Data, mime: String) -> Bool {
        guard bytes.count >= 12 else { return false }
        let signature = String(decoding: bytes.prefix(4), as: UTF8.self)
        switch mime {
        case "audio/wav":
            return ["RIFF", "RIFX", "RF64"].contains(signature) && bytes[8..<12].elementsEqual("WAVE".utf8)
        case "audio/flac":
            return signature == "fLaC" || bytes.starts(with: "ID3".utf8)
        case "audio/mpeg":
            return bytes.starts(with: "ID3".utf8) || (bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0)
        case "audio/aac":
            return signature == "ADIF" || bytes.starts(with: "ID3".utf8) || (bytes[0] == 0xff && bytes[1] & 0xf6 == 0xf0)
        case "audio/ogg": return signature == "OggS"
        case "audio/webm": return bytes.starts(with: [0x1a, 0x45, 0xdf, 0xa3])
        case "audio/mp4": return ["ftyp", "moov", "mdat", "free", "wide"].contains(String(decoding: bytes[4..<8], as: UTF8.self))
        default: return false
        }
    }
}
