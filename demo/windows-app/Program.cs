// CareClinic for Windows — the same small app as the phone and macOS demos, for StepForge's Windows tests.
// Demo account: nurse@careclinic.test / CareClinic1. In UI Automation, a control's Name property is its
// AutomationId and its AccessibleName is its Name.
using System;
using System.Drawing;
using System.Windows.Forms;

namespace CareClinic;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}

internal sealed class MainForm : Form
{
    private readonly FlowLayoutPanel signIn = Column();
    private readonly FlowLayoutPanel patients = Column();
    private readonly TextBox email = Field("email", "Email");
    private readonly TextBox password = Field("password", "Password");
    private readonly Label error = Text("error", "");
    private readonly TextBox patientName = Field("patient_name", "Patient name");
    private readonly Label counter = Text("patient_count", "No patients yet");
    private readonly FlowLayoutPanel list = Column();
    private int count;

    public MainForm()
    {
        Text = "CareClinic";
        ClientSize = new Size(480, 520);
        password.UseSystemPasswordChar = true;
        error.ForeColor = Color.Firebrick;

        var signInButton = Button("sign_in", "Sign in");
        signInButton.Click += (_, _) => SubmitSignIn();
        signIn.Controls.AddRange(new Control[] { email, password, signInButton, error });

        var add = Button("add_patient", "Add patient");
        add.Click += (_, _) => AddPatient();
        var signOut = Button("sign_out", "Sign out");
        signOut.Click += (_, _) => Show(signIn);
        list.Name = "patient_list";
        list.AccessibleName = "Patients";
        patients.Controls.AddRange(new Control[] { patientName, add, counter, list, signOut });

        // The menu bar: Patients > Add Patient (Ctrl+N), Patients > Clear List (asks first).
        var menu = new MenuStrip();
        var patientsMenu = new ToolStripMenuItem("Patients");
        var addItem = new ToolStripMenuItem("Add Patient", null, (_, _) => patientName.Focus())
        {
            ShortcutKeys = Keys.Control | Keys.N,
        };
        var clearItem = new ToolStripMenuItem("Clear List", null, (_, _) => ClearList());
        patientsMenu.DropDownItems.AddRange(new ToolStripItem[] { addItem, clearItem });
        menu.Items.Add(patientsMenu);
        MainMenuStrip = menu;

        Controls.Add(signIn);
        Controls.Add(patients);
        Controls.Add(menu);
        Show(signIn);
    }

    private void Show(Control screen)
    {
        signIn.Visible = screen == signIn;
        patients.Visible = screen == patients;
    }

    private void SubmitSignIn()
    {
        if (email.Text.Trim() == "nurse@careclinic.test" && password.Text == "CareClinic1")
        {
            error.Text = "";
            Show(patients);
        }
        else
        {
            error.Text = "Wrong email or password";
        }
    }

    private void AddPatient()
    {
        var n = patientName.Text.Trim();
        if (n.Length == 0) return;
        // PLANTED BUG WIN-01: long names are cut to 12 characters in the list.
        list.Controls.Add(new Label { Name = "patient_row", Text = n.Length > 12 ? n[..12] : n, AutoSize = true });
        count++;
        counter.Text = count == 1 ? "1 patient" : $"{count} patients";
        patientName.Text = "";
    }

    private void ClearList()
    {
        if (!patients.Visible) return;
        if (MessageBox.Show(this, "Clear the patient list?", "CareClinic", MessageBoxButtons.YesNo) != DialogResult.Yes)
            return;
        list.Controls.Clear();
        count = 0;
        counter.Text = "No patients yet";
    }

    private static FlowLayoutPanel Column() => new()
    {
        FlowDirection = FlowDirection.TopDown,
        Dock = DockStyle.Fill,
        Padding = new Padding(24, 40, 24, 24),
        WrapContents = false,
        AutoSize = true,
    };

    private static TextBox Field(string id, string placeholder) => new()
    {
        Name = id,
        AccessibleName = placeholder,
        PlaceholderText = placeholder,
        Width = 300,
    };

    private static Label Text(string id, string text) => new() { Name = id, Text = text, AutoSize = true };

    private static Button Button(string id, string text) => new() { Name = id, Text = text, AutoSize = true };
}
