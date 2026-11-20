import Foundation
import SwiftUI

/// 只存在于一个已授权账号的一次设备工作台会话。队列使连续的设置更改按输入顺序生效。
@MainActor
final class DeviceAccess {
    typealias Check = (@escaping (Bool) -> Void) -> Void
    private let check: Check
    private(set) var active = true
    private var pending: [() -> Void] = []
    private var checking = false

    init(check: @escaping Check) { self.check = check }

    func perform(_ action: @escaping () -> Void) {
        guard active else { return }
        pending.append(action)
        checkNext()
    }

    private func checkNext() {
        guard active, !checking, !pending.isEmpty else { return }
        checking = true
        check { [weak self] allowed in
            guard let self, self.active else { return }
            guard allowed else { self.invalidate(); return }
            let action = self.pending.removeFirst()
            action()
            self.checking = false
            self.checkNext()
        }
    }

    func binding<Value>(_ binding: Binding<Value>) -> Binding<Value> {
        Binding(get: { binding.wrappedValue }, set: { value in self.perform { binding.wrappedValue = value } })
    }

    func invalidate() {
        active = false
        pending.removeAll()
    }
}
