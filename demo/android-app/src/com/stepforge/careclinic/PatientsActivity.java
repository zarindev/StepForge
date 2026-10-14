package com.stepforge.careclinic;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** CareClinic mobile — today's patients: add a patient, see the count and the list. */
public class PatientsActivity extends Activity {
    private int count = 0;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = Ui.column(this);
        root.addView(Ui.title(this, "Patients"));
        final EditText name = Ui.field(this, R.id.patient_name, "Patient name", false);
        Button add = Ui.button(this, R.id.add_patient, "Add patient");
        final TextView counter = Ui.text(this, R.id.patient_count, "No patients yet");
        final LinearLayout list = new LinearLayout(this);
        list.setId(R.id.patient_list);
        list.setOrientation(LinearLayout.VERTICAL);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(list);
        Button signOut = Ui.button(this, R.id.sign_out, "Sign out");
        Button remind = Ui.button(this, R.id.remind, "Remind me");
        final TextView reminders = Ui.text(this, R.id.reminders, "");
        // A dialog to answer (ui.handleDialog).
        remind.setOnClickListener(v -> new AlertDialog.Builder(this)
                .setTitle("Turn on reminders?")
                .setMessage("CareClinic reminds you before each appointment.")
                .setPositiveButton("Turn on", (d, w) -> reminders.setText("Reminders on"))
                .setNegativeButton("Not now", (d, w) -> reminders.setText("Reminders off"))
                .show());
        root.addView(name);
        root.addView(add);
        root.addView(counter);
        root.addView(scroll, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        root.addView(remind);
        root.addView(reminders);
        root.addView(signOut);
        add.setOnClickListener(v -> {
            String n = name.getText().toString().trim();
            if (n.isEmpty()) return;
            // PLANTED BUG ANDROID-01: long names are cut to 12 characters in the list.
            TextView row = Ui.text(this, 0, n.length() > 12 ? n.substring(0, 12) : n);
            // A long press removes the patient (ui.longPress).
            row.setOnLongClickListener(r -> {
                list.removeView(r);
                count--;
                counter.setText(label(count));
                return true;
            });
            list.addView(row);
            count++;
            counter.setText(label(count));
            name.setText("");
        });
        signOut.setOnClickListener(v -> finish());
        setContentView(root);
    }

    private static String label(int count) {
        return count == 0 ? "No patients yet" : count == 1 ? "1 patient" : count + " patients";
    }
}
