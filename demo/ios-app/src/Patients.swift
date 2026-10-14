import UIKit

/** Today's patients: add a patient, see the count and the list. */
final class PatientsViewController: UIViewController {
    private let name = Ui.field("patient_name", "Patient name")
    private let counter = Ui.label("patient_count", "No patients yet")
    private let list = UIStackView()
    private var count = 0

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Patients"
        view.backgroundColor = .systemBackground
        navigationItem.hidesBackButton = true
        let add = Ui.button("add_patient", "Add patient")
        add.addTarget(self, action: #selector(addPatient), for: .touchUpInside)
        let signOut = Ui.button("sign_out", "Sign out")
        signOut.addTarget(self, action: #selector(leave), for: .touchUpInside)
        list.axis = .vertical
        list.spacing = 8
        list.accessibilityIdentifier = "patient_list"
        _ = Ui.column(in: view, [name, add, counter, list, signOut])
    }

    @objc private func addPatient() {
        let n = name.text?.trimmingCharacters(in: .whitespaces) ?? ""
        if n.isEmpty { return }
        // PLANTED BUG IOS-01: long names are cut to 12 characters in the list.
        list.addArrangedSubview(Ui.label(nil, n.count > 12 ? String(n.prefix(12)) : n))
        count += 1
        counter.text = count == 1 ? "1 patient" : "\(count) patients"
        name.text = ""
    }

    @objc private func leave() {
        navigationController?.popViewController(animated: false)
    }
}
