import AppKit
import Foundation
import Observation

@MainActor @Observable
final class LocalWorkspaceService {
    private(set) var origin: URL?
    private(set) var error: String?
    @ObservationIgnored private var child: Process?
    @ObservationIgnored private var input: Pipe?
    @ObservationIgnored private var reader: Task<Void, Never>?
    @ObservationIgnored private var startupTimeout: Task<Void, Never>?

    static func announcedOrigin(_ line: String) -> URL? {
        let prefix = "Voice Studio   http://127.0.0.1:"
        guard line.hasPrefix(prefix) else { return nil }
        let suffix = line.dropFirst(prefix.count)
        guard let port = UInt16(suffix), port > 0, String(port) == suffix else { return nil }
        return URL(string: "http://127.0.0.1:\(port)")
    }

    static func sameOrigin(_ url: URL?, as origin: URL) -> Bool {
        guard let url else { return false }
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == origin.port &&
            url.user == nil && url.password == nil
    }

    func start() {
        guard child == nil else { return }
        error = nil
        let bundle = Bundle.main
        let resources = bundle.resourceURL?.appendingPathComponent("AccessService")
        var node = resources?.appendingPathComponent("bin/node")
        var script = resources?.appendingPathComponent("web/server.mjs")
        var bridge = bundle.executableURL?.deletingLastPathComponent().appendingPathComponent("QwenTTSBridge")
        #if DEBUG
        // swift run 的开发产物不带 .app 资源，使用同一仓库的服务入口。
        if bundle.bundleURL.pathExtension != "app" {
            let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            script = root.appendingPathComponent("web/server.mjs")
            node = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map {
                URL(fileURLWithPath: String($0)).appendingPathComponent("node")
            }.first { FileManager.default.isExecutableFile(atPath: $0.path) }
            bridge = root.appendingPathComponent(".xcbuild/Build/Products/Release/QwenTTSBridge")
        }
        #endif
        guard let node, let script, FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.isReadableFile(atPath: script.path) else {
            error = "应用缺少本机账号服务，请重新安装完整的 Voice Studio。"
            return
        }
        let process = Process(), output = Pipe(), keepAlive = Pipe()
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = "0"
        env["QWEN_BRIDGE"] = bridge?.path
        env["VOICE_STUDIO_DESKTOP_CHILD"] = "1"
        env.removeValue(forKey: "NODE_OPTIONS")
        process.executableURL = node
        process.arguments = [script.path]
        process.environment = env
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.standardInput = keepAlive
        process.terminationHandler = { [weak self] finished in
            Task { @MainActor in
                guard let self, self.child === finished else { return }
                self.stop()
                self.error = "本机账号服务已停止，请重新启动。"
            }
        }
        do { try process.run() } catch {
            self.error = "无法启动本机账号服务，请重新打开应用。"
            return
        }
        child = process
        input = keepAlive
        reader = Task { [weak self] in
            do {
                for try await line in output.fileHandleForReading.bytes.lines {
                    guard !Task.isCancelled, let self, self.child === process else { break }
                    if self.origin == nil, let origin = Self.announcedOrigin(line) {
                        self.startupTimeout?.cancel()
                        self.origin = origin
                    }
                }
            } catch { /* 关闭子进程时读取会结束。 */ }
        }
        startupTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled, let self, self.child === process, self.origin == nil else { return }
            self.stop()
            self.error = "本机账号服务启动超时，请重试。"
        }
    }

    @discardableResult
    func stop() -> Task<Void, Never>? {
        origin = nil
        let process = child
        child = nil
        startupTimeout?.cancel()
        reader?.cancel()
        try? input?.fileHandleForWriting.close()
        input = nil
        guard let process, process.isRunning else { return nil }
        // 先给服务时间取消转换、回收桥接进程并关闭数据库。应用正常退出也等待此任务。
        return Task { @MainActor in
            for _ in 0..<50 {
                guard process.isRunning else { return }
                try? await Task.sleep(for: .milliseconds(100))
            }
            if process.isRunning { process.terminate() }
            for _ in 0..<20 {
                guard process.isRunning else { return }
                try? await Task.sleep(for: .milliseconds(100))
            }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }
}
