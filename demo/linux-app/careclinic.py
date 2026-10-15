#!/usr/bin/env python3
"""
CareClinic for Linux: a small GTK 3 app for StepForge's Linux tests (the same app as the phone and desktop demos).
Demo account: nurse@careclinic.test / CareClinic1. Each control has an accessible id (what a test id finds).
Needs python3-gi and gir1.2-gtk-3.0.
"""
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, Gtk  # noqa: E402


def with_id(widget, ident):
    """The accessible id that AT-SPI reports (ATK 2.34+)."""
    acc = widget.get_accessible()
    try:
        acc.set_accessible_id(ident)
    except AttributeError:
        acc.set_description(ident)
    return widget


def field(ident, placeholder, secret=False):
    e = Gtk.Entry(placeholder_text=placeholder, visibility=not secret)
    e.get_accessible().set_name(placeholder)
    return with_id(e, ident)


def button(ident, label):
    return with_id(Gtk.Button(label=label), ident)


def label(ident, text):
    lab = Gtk.Label(label=text, xalign=0)
    return with_id(lab, ident) if ident else lab


class CareClinic(Gtk.Window):
    def __init__(self):
        super().__init__(title="CareClinic")
        self.set_default_size(480, 520)
        self.count = 0
        accel = Gtk.AccelGroup()
        self.add_accel_group(accel)

        # The menu bar: Patients > Add Patient (Ctrl+N), Patients > Clear List (asks first).
        bar = Gtk.MenuBar()
        top = Gtk.MenuItem(label="Patients")
        menu = Gtk.Menu()
        add_item = Gtk.MenuItem(label="Add Patient")
        add_item.add_accelerator("activate", accel, Gdk.keyval_from_name("n"), Gdk.ModifierType.CONTROL_MASK, Gtk.AccelFlags.VISIBLE)
        add_item.connect("activate", lambda *_: self.name.grab_focus())
        clear_item = Gtk.MenuItem(label="Clear List")
        clear_item.connect("activate", lambda *_: self.clear_list())
        menu.append(add_item)
        menu.append(clear_item)
        top.set_submenu(menu)
        bar.append(top)

        self.stack = Gtk.Stack()
        # Sign in.
        sign = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12, margin=24)
        self.email = field("email", "Email")
        self.password = field("password", "Password", secret=True)
        sign_in = button("sign_in", "Sign in")
        sign_in.connect("clicked", self.submit)
        self.error = label("error", "")
        for w in (self.email, self.password, sign_in, self.error):
            sign.pack_start(w, False, False, 0)
        # Patients.
        pats = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12, margin=24)
        self.name = field("patient_name", "Patient name")
        add = button("add_patient", "Add patient")
        add.connect("clicked", self.add_patient)
        self.counter = label("patient_count", "No patients yet")
        self.list = with_id(Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6), "patient_list")
        sign_out = button("sign_out", "Sign out")
        sign_out.connect("clicked", lambda *_: self.stack.set_visible_child_name("sign_in"))
        for w in (self.name, add, self.counter, self.list, sign_out):
            pats.pack_start(w, False, False, 0)
        self.stack.add_named(sign, "sign_in")
        self.stack.add_named(pats, "patients")

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        box.pack_start(bar, False, False, 0)
        box.pack_start(self.stack, True, True, 0)
        self.add(box)
        self.connect("destroy", Gtk.main_quit)

    def submit(self, *_):
        if self.email.get_text().strip() == "nurse@careclinic.test" and self.password.get_text() == "CareClinic1":
            self.error.set_text("")
            self.stack.set_visible_child_name("patients")
        else:
            self.error.set_text("Wrong email or password")

    def add_patient(self, *_):
        n = self.name.get_text().strip()
        if not n:
            return
        # PLANTED BUG LINUX-01: long names are cut to 12 characters in the list.
        row = label("patient_row", n[:12] if len(n) > 12 else n)
        self.list.pack_start(row, False, False, 0)
        row.show()
        self.count += 1
        self.counter.set_text("1 patient" if self.count == 1 else f"{self.count} patients")
        self.name.set_text("")

    def clear_list(self):
        if self.stack.get_visible_child_name() != "patients":
            return
        dialog = Gtk.MessageDialog(transient_for=self, modal=True, message_type=Gtk.MessageType.QUESTION, text="Clear the patient list?")
        dialog.add_buttons("Cancel", Gtk.ResponseType.CANCEL, "Clear", Gtk.ResponseType.OK)
        if dialog.run() == Gtk.ResponseType.OK:
            for child in self.list.get_children():
                self.list.remove(child)
            self.count = 0
            self.counter.set_text("No patients yet")
        dialog.destroy()


if __name__ == "__main__":
    win = CareClinic()
    win.show_all()
    Gtk.main()
