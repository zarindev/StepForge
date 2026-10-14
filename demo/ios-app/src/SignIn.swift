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
        _ = Ui.column(in: view, [email, password, signIn, error])
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
