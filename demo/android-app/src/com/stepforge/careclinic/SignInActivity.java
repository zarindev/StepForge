package com.stepforge.careclinic;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/** CareClinic mobile — sign in. Demo account: nurse@careclinic.test / CareClinic1 */
public class SignInActivity extends Activity {
    static final String EMAIL = "nurse@careclinic.test";
    static final String PASSWORD = "CareClinic1";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = Ui.column(this);
        root.addView(Ui.title(this, "CareClinic"));
        final EditText email = Ui.field(this, R.id.email, "Email", false);
        final EditText password = Ui.field(this, R.id.password, "Password", true);
        Button signIn = Ui.button(this, R.id.sign_in, "Sign in");
        final TextView error = Ui.text(this, R.id.error, "");
        error.setTextColor(Color.rgb(200, 30, 30));
        root.addView(email);
        root.addView(password);
        root.addView(signIn);
        root.addView(error);
        signIn.setOnClickListener(v -> {
            if (EMAIL.equals(email.getText().toString().trim())
                    && PASSWORD.equals(password.getText().toString())) {
                error.setText("");
                startActivity(new Intent(this, PatientsActivity.class));
            } else {
                error.setText("Wrong email or password");
            }
        });
        setContentView(root);
    }
}
