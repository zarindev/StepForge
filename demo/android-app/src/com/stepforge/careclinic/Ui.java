package com.stepforge.careclinic;

import android.content.Context;
import android.text.InputType;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Small helpers: the screens are built in code, so the app needs no layout files. */
final class Ui {
    private Ui() {}

    static LinearLayout column(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        int p = dp(c, 24);
        l.setPadding(p, p, p, p);
        l.setGravity(Gravity.TOP);
        return l;
    }

    static TextView title(Context c, String text) {
        TextView t = new TextView(c);
        t.setText(text);
        t.setTextSize(26);
        t.setPadding(0, 0, 0, dp(c, 16));
        return t;
    }

    static EditText field(Context c, int id, String hint, boolean password) {
        EditText e = new EditText(c);
        e.setId(id);
        e.setHint(hint);
        e.setSingleLine(true);
        e.setInputType(password
                ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD
                : InputType.TYPE_CLASS_TEXT);
        return e;
    }

    static Button button(Context c, int id, String text) {
        Button b = new Button(c);
        b.setId(id);
        b.setText(text);
        b.setAllCaps(false);
        return b;
    }

    static TextView text(Context c, int id, String text) {
        TextView t = new TextView(c);
        if (id != 0) t.setId(id);
        t.setText(text);
        t.setTextSize(16);
        t.setPadding(0, dp(c, 8), 0, dp(c, 8));
        return t;
    }

    static int dp(Context c, int v) {
        return Math.round(v * c.getResources().getDisplayMetrics().density);
    }
}
