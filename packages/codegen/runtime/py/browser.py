"""Selenium helpers for tests exported by StepForge (by Md Zarin Tasnim).

Locators are (strategy, value, name) tuples, the same strategies StepForge records: testId, role, label, placeholder,
text, css and xpath. Every lookup and check waits (default 10 s), like Playwright's auto-waiting.
"""
import fnmatch
import re
import time
from pathlib import Path
from urllib.parse import urljoin

from selenium.common.exceptions import (
    NoAlertPresentException,
    StaleElementReferenceException,
    WebDriverException,
)
from selenium.webdriver import ActionChains, Keys
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import Select

from support.helpers import compare

_FIND = (Path(__file__).parent / "find.js").read_text(encoding="utf-8")

KEYS = {
    "Enter": Keys.ENTER, "Tab": Keys.TAB, "Escape": Keys.ESCAPE, "Backspace": Keys.BACKSPACE, "Delete": Keys.DELETE,
    "ArrowDown": Keys.ARROW_DOWN, "ArrowUp": Keys.ARROW_UP, "ArrowLeft": Keys.ARROW_LEFT, "ArrowRight": Keys.ARROW_RIGHT,
    "Home": Keys.HOME, "End": Keys.END, "PageUp": Keys.PAGE_UP, "PageDown": Keys.PAGE_DOWN, "Space": Keys.SPACE,
}


class Browser:
    def __init__(self, driver, base_url, timeout=10):
        self.driver = driver
        self.base_url = base_url
        self.timeout = timeout
        self._dialog = None

    # ─── Finding ───────────────────────────────────────────────────────────
    def _query(self, loc):
        strategy, value = loc[0], loc[1]
        name = loc[2] if len(loc) > 2 else None
        if strategy == "css":
            return self.driver.find_elements(By.CSS_SELECTOR, value)
        if strategy == "xpath":
            return self.driver.find_elements(By.XPATH, value)
        return self.driver.execute_script(_FIND, strategy, value, name) or []

    def _wait(self, fn, message):
        deadline = time.time() + self.timeout
        last = None
        while True:
            try:
                result = fn()
                if result:
                    return result
            except (StaleElementReferenceException, WebDriverException) as err:
                last = err
            if time.time() > deadline:
                raise AssertionError(message + (f" ({last.__class__.__name__})" if last else ""))
            time.sleep(0.1)

    def all(self, loc):
        return self._query(loc)

    def el(self, loc):
        """The first matching element, waiting until it is visible."""
        return self._wait(lambda: next((e for e in self._query(loc) if e.is_displayed()), None), f"No visible element {loc}")

    # ─── Actions ───────────────────────────────────────────────────────────
    def goto(self, url):
        self.driver.get(url if url.startswith(("http://", "https://")) else urljoin(self.base_url.rstrip("/") + "/", url.lstrip("/")))

    def click(self, loc, double=False, right=False):
        el = self._wait(lambda: next((e for e in self._query(loc) if e.is_displayed() and e.is_enabled()), None), f"No clickable element {loc}")
        if double:
            ActionChains(self.driver).double_click(el).perform()
        elif right:
            ActionChains(self.driver).context_click(el).perform()
        else:
            el.click()
        self._answer_dialog()

    def hover(self, loc):
        ActionChains(self.driver).move_to_element(self.el(loc)).perform()

    def fill(self, loc, value):
        el = self.el(loc)
        el.clear()
        if value != "":
            el.send_keys(value)

    def type(self, loc, value):
        self.el(loc).send_keys(value)

    def clear(self, loc):
        self.el(loc).clear()

    def set_checked(self, loc, checked):
        el = self.el(loc)
        if el.is_selected() != checked:
            el.click()

    def press(self, loc, key):
        keys = KEYS.get(key, key)
        if "+" in key and key not in KEYS:
            mods = {"Control": Keys.CONTROL, "Meta": Keys.COMMAND, "Shift": Keys.SHIFT, "Alt": Keys.ALT}
            *held, last = key.split("+")
            keys = "".join(mods.get(m, m) for m in held) + KEYS.get(last, last.lower())
        target = self.el(loc) if loc else self.driver.switch_to.active_element
        target.send_keys(keys)
        self._answer_dialog()

    def select(self, loc, value=None, label=None, index=None):
        s = Select(self.el(loc))
        if label is not None:
            s.select_by_visible_text(label)
        elif index is not None:
            s.select_by_index(int(index))
        else:
            s.select_by_value(str(value))

    def upload(self, loc, *files):
        el = self._wait(lambda: next(iter(self._query(loc)), None), f"No element {loc}")
        el.send_keys("\n".join(str(Path(f).resolve()) for f in files))

    def drag(self, loc, target):
        ActionChains(self.driver).drag_and_drop(self.el(loc), self.el(target)).perform()

    def scroll_into_view(self, loc):
        self.driver.execute_script("arguments[0].scrollIntoView({block: 'center'})", self.el(loc))

    def scroll(self, x, y):
        self.driver.execute_script("window.scrollBy(arguments[0], arguments[1])", x, y)

    def screenshot(self, name, loc=None):
        Path("screenshots").mkdir(exist_ok=True)
        path = f"screenshots/{name}.png"
        (self.el(loc).screenshot(path) if loc else self.driver.save_screenshot(path))

    # ─── Dialogs, frames, tabs ─────────────────────────────────────────────
    def handle_next_dialog(self, accept=True, prompt_text=None):
        """StepForge places this before the step that opens the dialog; it is answered after that step."""
        self._dialog = (accept, prompt_text)

    def _answer_dialog(self):
        if not self._dialog:
            return
        deadline = time.time() + 2
        while time.time() < deadline:
            try:
                alert = self.driver.switch_to.alert
                accept, text = self._dialog
                if text is not None:
                    alert.send_keys(text)
                alert.accept() if accept else alert.dismiss()
                self._dialog = None
                return
            except NoAlertPresentException:
                time.sleep(0.1)

    def frame(self, css=None):
        if css is None:
            self.driver.switch_to.default_content()
        else:
            self.driver.switch_to.frame(self.el(("css", css)))

    def switch_tab(self, index=None, url_contains=None):
        def find():
            handles = self.driver.window_handles
            if index is not None:
                return handles[index] if index < len(handles) else None
            if url_contains is not None:
                for h in handles:
                    self.driver.switch_to.window(h)
                    if url_contains in self.driver.current_url:
                        return h
                return None
            return handles[-1] if len(handles) > 1 else None

        self.driver.switch_to.window(self._wait(find, "No such tab"))

    def close_tab(self):
        self.driver.close()
        self.driver.switch_to.window(self.driver.window_handles[-1])

    # ─── Waiting and checks ────────────────────────────────────────────────
    def wait_for(self, loc, state="visible"):
        checks = {
            "visible": lambda: any(e.is_displayed() for e in self._query(loc)),
            "hidden": lambda: not any(e.is_displayed() for e in self._query(loc)),
            "attached": lambda: len(self._query(loc)) > 0,
            "detached": lambda: len(self._query(loc)) == 0,
        }
        self._wait(checks[state], f"{loc} did not become {state}")

    def wait_for_url(self, pattern):
        self._wait(lambda: fnmatch.fnmatch(self.driver.current_url, pattern) or pattern in self.driver.current_url, f"URL never matched {pattern}")

    def wait_for_load(self):
        self._wait(lambda: self.driver.execute_script("return document.readyState") == "complete", "The page did not finish loading")

    def read(self, source, loc=None, attribute=None):
        if source == "url":
            return self.driver.current_url
        if source == "title":
            return self.driver.title
        if source == "count":
            return len(self._query(loc))
        el = self.el(loc)
        if source == "value":
            return el.get_attribute("value")
        if source == "attribute":
            return el.get_attribute(attribute)
        return (el.get_attribute("textContent") or "").strip()

    def expect(self, check, loc=None, expected=None, attribute=None):
        """StepForge's UI checks, retried until they pass or the timeout ends."""
        def norm(s):
            return re.sub(r"\s+", " ", s or "").strip()

        def ok():
            if check.startswith("url"):
                actual = self.driver.current_url
                want = str(expected)
                if check == "url":
                    return actual == (want if want.startswith("http") else urljoin(self.base_url, want))
                return want in actual if check == "urlContains" else re.search(want, actual) is not None
            if check.startswith("title"):
                return self.driver.title == expected if check == "title" else str(expected) in self.driver.title
            els = self._query(loc)
            shown = [e for e in els if e.is_displayed()]
            if check == "hidden":
                return not shown
            if check == "count":
                return compare(len(els), "equals", expected)
            if not shown:
                return False
            el = shown[0]
            text = norm(el.get_attribute("textContent"))
            return {
                "visible": lambda: True,
                "text": lambda: text == norm(str(expected)),
                "textContains": lambda: str(expected) in text,
                "textMatches": lambda: re.search(str(expected), text) is not None,
                "value": lambda: el.get_attribute("value") == str(expected),
                "attribute": lambda: el.get_attribute(attribute) == str(expected),
                "enabled": lambda: el.is_enabled(),
                "disabled": lambda: not el.is_enabled(),
                "checked": lambda: el.is_selected(),
                "unchecked": lambda: not el.is_selected(),
            }[check]()

        self._wait(ok, f"Expected {loc or 'the page'} {check}{'' if expected is None else ' ' + repr(expected)}")
