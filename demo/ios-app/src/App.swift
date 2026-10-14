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
