import UIKit

// CareClinic mobile (iOS) — the same small app as demo/android-app, for StepForge's iOS tests.
// Demo account: nurse@careclinic.test / CareClinic1

@main
@objc(AppDelegate)
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        configurationForConnecting session: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default", sessionRole: session.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

@objc(SceneDelegate)
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = UINavigationController(rootViewController: SignInViewController())
        window.makeKeyAndVisible()
        self.window = window
        if let url = options.urlContexts.first?.url { open(url) }
    }

    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        if let url = contexts.first?.url { open(url) }
    }

    /// careclinic://patients opens the patients screen.
    private func open(_ url: URL) {
        guard url.host == "patients", let nav = window?.rootViewController as? UINavigationController else { return }
        if !(nav.topViewController is PatientsViewController) {
            nav.pushViewController(PatientsViewController(), animated: false)
        }
    }
}

/** Small helpers: the screens are built in code. */
enum Ui {
    static func field(_ id: String, _ placeholder: String, secure: Bool = false) -> UITextField {
        let f = UITextField()
        f.accessibilityIdentifier = id
        f.placeholder = placeholder
        f.borderStyle = .roundedRect
        f.autocapitalizationType = .none
        f.autocorrectionType = .no
        f.isSecureTextEntry = secure
        // Return closes the keyboard, as in most apps.
        f.addAction(UIAction { _ in }, for: .editingDidEndOnExit)
        return f
    }

    static func button(_ id: String, _ title: String) -> UIButton {
        let b = UIButton(type: .system)
        b.accessibilityIdentifier = id
        b.setTitle(title, for: .normal)
        b.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        return b
    }

    static func label(_ id: String?, _ text: String) -> UILabel {
        let l = UILabel()
        if let id { l.accessibilityIdentifier = id }
        l.text = text
        l.numberOfLines = 0
        return l
    }

    /// A column inside a scroll view, for screens taller than the display.
    static func scrollingColumn(in view: UIView, _ views: [UIView]) -> UIStackView {
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        let stack = UIStackView(arrangedSubviews: views)
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -24),
        ])
        return stack
    }

    static func column(in view: UIView, _ views: [UIView]) -> UIStackView {
        let stack = UIStackView(arrangedSubviews: views)
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
        ])
        return stack
    }
}
