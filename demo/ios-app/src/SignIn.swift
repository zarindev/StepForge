import UIKit

final class SignInViewController: UIViewController {
    private let email = Ui.field("email", "Email")
    private let password = Ui.field("password", "Password", secure: true)
    private let error = Ui.label("error", "")

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "CareClinic"
        view.backgroundColor = .systemBackground
        error.textColor = .systemRed
        let signIn = Ui.button("sign_in", "Sign in")
        signIn.addTarget(self, action: #selector(submit), for: .touchUpInside)
        // Far below the form: tests scroll to it (ui.scrollTo, ui.swipe).
        let gap = UIView()
        gap.heightAnchor.constraint(equalToConstant: 1500).isActive = true
        let version = Ui.label("app_version", "Version 1.0 · support@careclinic.test")
        _ = Ui.scrollingColumn(in: view, [email, password, signIn, error, gap, version])
    }

    @objc private func submit() {
        let ok = email.text?.trimmingCharacters(in: .whitespaces) == "nurse@careclinic.test"
            && password.text == "CareClinic1"
        if ok {
            error.text = ""
            navigationController?.pushViewController(PatientsViewController(), animated: false)
        } else {
            error.text = "Wrong email or password"
        }
    }
}
