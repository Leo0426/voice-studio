import Darwin
import Foundation

public struct OpenAIKeyConfiguration: Sendable {
    public enum Source: Equatable, Sendable {
        case unconfigured, sharedFile, environment
    }

    public static let fileURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Voice Studio/openai.env")

    private let url: URL
    private let environment: [String: String]

    public init() {
        self.init(url: Self.fileURL, environment: ProcessInfo.processInfo.environment)
    }

    init(url: URL, environment: [String: String]) {
        self.url = url
        self.environment = environment
    }

    public var source: Source { credential.source }
    var key: String? { credential.key }

    public func save(_ key: String) throws {
        guard environmentKey == nil else { throw KeyError.fromEnvironment }
        guard (1...4096).contains(key.utf8.count), key.utf8.allSatisfy(Self.isKeyByte) else {
            throw KeyError.invalidInput
        }
        let directory = url.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                   attributes: [.posixPermissions: 0o700])
            let existing = try contents() ?? ""
            let entries = Self.keyAssignments(in: existing)
            let updated = NSMutableString(string: existing)
            // Replace every definition, including legacy duplicates, without leaving an old secret in the file.
            for entry in entries.reversed() {
                updated.replaceCharacters(in: entry.range(at: 2), with: key)
            }
            if entries.isEmpty {
                let newline = existing.contains("\r\n") ? "\r\n" : "\n"
                if !existing.isEmpty && !existing.hasSuffix("\n") { updated.append(newline) }
                updated.append("OPENAI_API_KEY=\(key)\(newline)")
            }
            try writePrivately(Data((updated as String).utf8), in: directory)
        } catch {
            throw KeyError.cannotSave
        }
    }

    private var environmentKey: String? { Self.readableKey(environment["OPENAI_API_KEY"]) }

    private var credential: (source: Source, key: String?) {
        if let key = environmentKey { return (.environment, key) }
        if let text = try? contents(), let match = Self.keyAssignments(in: text).last {
            var value = (text as NSString).substring(with: match.range(at: 2))
            if let quote = value.first, ["\"", "'", "`"].contains(quote) {
                guard value.count >= 2, value.last == quote else { return (.unconfigured, nil) }
                value = String(value.dropFirst().dropLast())
            }
            if let key = Self.readableKey(value) { return (.sharedFile, key) }
        }
        return (.unconfigured, nil)
    }

    private static func isKeyByte(_ byte: UInt8) -> Bool {
        switch byte {
        case 48...57, 65...90, 97...122, 43, 45, 46, 47, 61, 95: true
        default: false
        }
    }

    // Existing environment values retain the same compatibility as the speech API client.
    private static func readableKey(_ value: String?) -> String? {
        guard let key = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !key.isEmpty, key.utf8.allSatisfy({ (33...126).contains($0) }) else { return nil }
        return key
    }

    // Match all assignments so a key-like line inside a multiline quoted value stays untouched.
    private static let assignment = try! NSRegularExpression(
        pattern: #"^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*("[^"]*"|'[^']*'|`[^`]*`|[^#\r\n]*?)[ \t]*(?:#[^\r\n]*)?\r?$"#,
        options: [.anchorsMatchLines]
    )

    private static func keyAssignments(in text: String) -> [NSTextCheckingResult] {
        let source = text as NSString
        return assignment.matches(in: text, range: NSRange(location: 0, length: source.length))
            .filter { source.substring(with: $0.range(at: 1)) == "OPENAI_API_KEY" }
    }

    private func contents() throws -> String? {
        let fd = Darwin.open(url.path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW)
        guard fd >= 0 else {
            if errno == ENOENT { return nil }
            throw KeyError.cannotSave
        }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? file.close() }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { throw KeyError.cannotSave }
        let data = try file.readToEnd() ?? Data()
        guard let text = String(data: data, encoding: .utf8) else { throw KeyError.cannotSave }
        return text
    }

    private func writePrivately(_ data: Data, in directory: URL) throws {
        let temporary = directory.appendingPathComponent(".openai-\(UUID().uuidString).tmp")
        let fd = Darwin.open(temporary.path, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw KeyError.cannotSave }
        defer { try? FileManager.default.removeItem(at: temporary) }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        guard fchmod(fd, 0o600) == 0 else { throw KeyError.cannotSave }
        try file.write(contentsOf: data)
        try file.synchronize()
        try file.close()
        guard rename(temporary.path, url.path) == 0 else { throw KeyError.cannotSave }
    }

    private enum KeyError: LocalizedError {
        case fromEnvironment, invalidInput, cannotSave

        var errorDescription: String? {
            switch self {
            case .fromEnvironment: "当前使用 OPENAI_API_KEY 环境变量。要更换密钥，请更新环境变量并重新启动应用。"
            case .invalidInput: "请输入 1 至 4096 个字符，仅支持英文字母、数字及 . _ + / = -。"
            case .cannotSave: "无法保存密钥。请检查 Voice Studio 配置文件的读写权限。"
            }
        }
    }
}
