import UIKit
import UserNotifications

/** Today's patients: add a patient, see the count and the list. */
final class PatientsViewController: UIViewController {
    private let name = Ui.field("patient_name", "Patient name")
    private let counter = Ui.label("patient_count", "No patients yet")
    private let list = UIStackView()
    private let reminders = Ui.label("reminders", "")
    private var count = 0

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Patients"
        view.backgroundColor = .systemBackground
        let add = Ui.button("add_patient", "Add patient")
        add.addTarget(self, action: #selector(addPatient), for: .touchUpInside)
        let signOut = Ui.button("sign_out", "Sign out")
        let remind = Ui.button("remind", "Remind me")
        remind.addTarget(self, action: #selector(askForReminders), for: .touchUpInside)
        signOut.addTarget(self, action: #selector(leave), for: .touchUpInside)
        list.axis = .vertical
        list.spacing = 8
        list.accessibilityIdentifier = "patient_list"
        _ = Ui.column(in: view, [name, add, counter, list, remind, reminders, signOut])
    }

    @objc private func addPatient() {
        let n = name.text?.trimmingCharacters(in: .whitespaces) ?? ""
        if n.isEmpty { return }
        // PLANTED BUG IOS-01: long names are cut to 12 characters in the list.
        let row = Ui.label(nil, n.count > 12 ? String(n.prefix(12)) : n)
        // A long press removes the patient (ui.longPress).
        row.isUserInteractionEnabled = true
        row.addGestureRecognizer(UILongPressGestureRecognizer(target: self, action: #selector(remove(_:))))
        list.addArrangedSubview(row)
        count += 1
        counter.text = label(count)
        name.text = ""
    }

    @objc private func remove(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began, let row = gesture.view else { return }
        row.removeFromSuperview()
        count -= 1
        counter.text = label(count)
    }

    private func label(_ count: Int) -> String {
        count == 0 ? "No patients yet" : count == 1 ? "1 patient" : "\(count) patients"
    }

    /// Asks iOS for permission to send reminders: the system shows a dialog (ui.handleDialog).
    @objc private func askForReminders() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            DispatchQueue.main.async { self.reminders.text = granted ? "Reminders on" : "Reminders off" }
        }
    }

    @objc private func leave() {
        navigationController?.popViewController(animated: false)
    }
}
