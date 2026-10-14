import AppKit

// CareClinic for macOS — a small AppKit app for StepForge's macOS tests (same app as the phone demos).
// Demo account: nurse@careclinic.test / CareClinic1

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let patients = PatientsView()

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 520),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "CareClinic"
        window.center()
        showSignIn()
        window.makeKeyAndOrderFront(nil)
        NSApp.mainMenu = makeMenu()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func showSignIn() {
        window.contentView = SignInView { [weak self] in self?.showPatients() }
    }

    func showPatients() {
        patients.onSignOut = { [weak self] in self?.showSignIn() }
        window.contentView = patients
    }

    /// The menu bar: the app menu and a Patients menu (ui.menu, keyboard shortcuts).
    private func makeMenu() -> NSMenu {
        let bar = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit CareClinic", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        bar.addItem(appItem)
        let patientsItem = NSMenuItem()
        let menu = NSMenu(title: "Patients")
        let add = NSMenuItem(title: "Add Patient", action: #selector(addPatient), keyEquivalent: "n")
        add.target = self
        menu.addItem(add)
        let clear = NSMenuItem(title: "Clear List", action: #selector(clearList), keyEquivalent: "")
        clear.target = self
        menu.addItem(clear)
        patientsItem.submenu = menu
        bar.addItem(patientsItem)
        return bar
    }

    /// Patients > Add Patient (⌘N): puts the cursor in the name field.
    @objc func addPatient() {
        guard window.contentView === patients else { return }
        window.makeFirstResponder(patients.name)
    }

    /// Patients > Clear List: asks first (a dialog to answer).
    @objc func clearList() {
        guard window.contentView === patients else { return }
        let alert = NSAlert()
        alert.messageText = "Clear the patient list?"
        alert.addButton(withTitle: "Clear")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in
            if response == .alertFirstButtonReturn { self.patients.clear() }
        }
    }
}

func field(_ id: String, _ placeholder: String, secure: Bool = false) -> NSTextField {
    let f = secure ? NSSecureTextField() : NSTextField()
    f.setAccessibilityIdentifier(id)
    f.placeholderString = placeholder
    return f
}

func label(_ id: String, _ text: String) -> NSTextField {
    let l = NSTextField(labelWithString: text)
    l.setAccessibilityIdentifier(id)
    return l
}

func column(_ views: [NSView]) -> NSStackView {
    let s = NSStackView(views: views)
    s.orientation = .vertical
    s.alignment = .leading
    s.spacing = 12
    s.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
    for v in views where v is NSTextField && (v as! NSTextField).isEditable {
        v.widthAnchor.constraint(equalToConstant: 300).isActive = true
    }
    return s
}

final class SignInView: NSStackView {
    private let email = field("email", "Email")
    private let password = field("password", "Password", secure: true)
    private let error = label("error", "")
    private let done: () -> Void

    init(done: @escaping () -> Void) {
        self.done = done
        super.init(frame: .zero)
        let button = NSButton(title: "Sign in", target: nil, action: nil)
        button.setAccessibilityIdentifier("sign_in")
        button.target = self
        button.action = #selector(submit)
        error.textColor = .systemRed
        let c = column([email, password, button, error])
        addArrangedSubview(c)
        orientation = .vertical
        alignment = .leading
    }

    required init?(coder: NSCoder) { fatalError() }

    @objc private func submit() {
        if email.stringValue.trimmingCharacters(in: .whitespaces) == "nurse@careclinic.test"
            && password.stringValue == "CareClinic1" {
            done()
        } else {
            error.stringValue = "Wrong email or password"
        }
    }
}

final class PatientsView: NSStackView {
    let name = field("patient_name", "Patient name")
    private let counter = label("patient_count", "No patients yet")
    private let list = NSStackView()
    private var count = 0
    var onSignOut: (() -> Void)?

    init() {
        super.init(frame: .zero)
        let add = NSButton(title: "Add patient", target: nil, action: nil)
        add.setAccessibilityIdentifier("add_patient")
        add.target = self
        add.action = #selector(addPatient)
        let signOut = NSButton(title: "Sign out", target: nil, action: nil)
        signOut.setAccessibilityIdentifier("sign_out")
        signOut.target = self
        signOut.action = #selector(leave)
        list.orientation = .vertical
        list.alignment = .leading
        list.setAccessibilityIdentifier("patient_list")
        addArrangedSubview(column([name, add, counter, list, signOut]))
        orientation = .vertical
        alignment = .leading
    }

    required init?(coder: NSCoder) { fatalError() }

    @objc private func addPatient() {
        let n = name.stringValue.trimmingCharacters(in: .whitespaces)
        if n.isEmpty { return }
        // PLANTED BUG MAC-01: long names are cut to 12 characters in the list.
        let row = NSTextField(labelWithString: n.count > 12 ? String(n.prefix(12)) : n)
        row.setAccessibilityIdentifier("patient_row")
        list.addArrangedSubview(row)
        count += 1
        counter.stringValue = count == 1 ? "1 patient" : "\(count) patients"
        name.stringValue = ""
    }

    func clear() {
        list.arrangedSubviews.forEach { $0.removeFromSuperview() }
        count = 0
        counter.stringValue = "No patients yet"
    }

    @objc private func leave() { onSignOut?() }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
