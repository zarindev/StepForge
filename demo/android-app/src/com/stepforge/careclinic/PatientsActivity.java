package com.stepforge.careclinic;

import android.app.Activity;
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
        root.addView(name);
        root.addView(add);
        root.addView(counter);
        root.addView(scroll, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        root.addView(signOut);
        add.setOnClickListener(v -> {
            String n = name.getText().toString().trim();
            if (n.isEmpty()) return;
            // PLANTED BUG ANDROID-01: long names are cut to 12 characters in the list.
            list.addView(Ui.text(this, 0, n.length() > 12 ? n.substring(0, 12) : n));
            count++;
            counter.setText(count == 1 ? "1 patient" : count + " patients");
            name.setText("");
        });
        signOut.setOnClickListener(v -> finish());
        setContentView(root);
    }
}
