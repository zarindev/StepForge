package support;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import org.openqa.selenium.Alert;
import org.openqa.selenium.By;
import org.openqa.selenium.JavascriptExecutor;
import org.openqa.selenium.Keys;
import org.openqa.selenium.NoAlertPresentException;
import org.openqa.selenium.OutputType;
import org.openqa.selenium.TakesScreenshot;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebDriverException;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.interactions.Actions;
import org.openqa.selenium.support.ui.Select;

/**
 * Selenium helpers for tests exported by StepForge (by Md Zarin Tasnim). Locators use the strategies StepForge records
 * (testId, role, label, placeholder, text, css, xpath); every lookup and check waits, like Playwright's auto-waiting.
 */
public final class Browser {
  /** A locator: strategy, value and (for roles) the accessible name. */
  public record Loc(String strategy, String value, String name) {
    public static Loc of(String strategy, String value) {
      return new Loc(strategy, value, null);
    }

    public static Loc of(String strategy, String value, String name) {
      return new Loc(strategy, value, name);
    }

    @Override
    public String toString() {
      return strategy + "=" + value + (name != null ? " \"" + name + "\"" : "");
    }
  }

  private static final String FIND = load();
  private static final Map<String, CharSequence> KEYS = Map.ofEntries(
      Map.entry("Enter", Keys.ENTER), Map.entry("Tab", Keys.TAB), Map.entry("Escape", Keys.ESCAPE),
      Map.entry("Backspace", Keys.BACK_SPACE), Map.entry("Delete", Keys.DELETE), Map.entry("ArrowDown", Keys.ARROW_DOWN),
      Map.entry("ArrowUp", Keys.ARROW_UP), Map.entry("ArrowLeft", Keys.ARROW_LEFT), Map.entry("ArrowRight", Keys.ARROW_RIGHT),
      Map.entry("Home", Keys.HOME), Map.entry("End", Keys.END), Map.entry("Space", Keys.SPACE));

  private final WebDriver driver;
  private final String baseUrl;
  private final Duration timeout;
  private Object[] dialog;

  public Browser(WebDriver driver, String baseUrl) {
    this.driver = driver;
    this.baseUrl = baseUrl;
    this.timeout = Duration.ofSeconds(10);
  }

  public WebDriver driver() {
    return driver;
  }

  private static String load() {
    try (InputStream in = Browser.class.getResourceAsStream("/find.js")) {
      return new String(in.readAllBytes(), StandardCharsets.UTF_8);
    } catch (Exception e) {
      throw new IllegalStateException("find.js is missing from src/test/resources", e);
    }
  }

  @SuppressWarnings("unchecked")
  private List<WebElement> query(Loc loc) {
    switch (loc.strategy()) {
      case "css": return driver.findElements(By.cssSelector(loc.value()));
      case "xpath": return driver.findElements(By.xpath(loc.value()));
      default:
        Object r = ((JavascriptExecutor) driver).executeScript(FIND, loc.strategy(), loc.value(), loc.name());
        return r == null ? List.of() : (List<WebElement>) r;
    }
  }

  private <T> T waitFor(Supplier<T> fn, String message) {
    long deadline = System.currentTimeMillis() + timeout.toMillis();
    RuntimeException last = null;
    while (true) {
      try {
        T v = fn.get();
        if (v != null && !Boolean.FALSE.equals(v)) return v;
      } catch (WebDriverException e) {
        last = e;
      }
      if (System.currentTimeMillis() > deadline) throw new AssertionError(message + (last != null ? " (" + last.getClass().getSimpleName() + ")" : ""));
      try {
        Thread.sleep(100);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new AssertionError(message);
      }
    }
  }

  /** The first matching element, waiting until it is visible. */
  public WebElement el(Loc loc) {
    return waitFor(() -> query(loc).stream().filter(WebElement::isDisplayed).findFirst().orElse(null), "No visible element " + loc);
  }

  public String url(String path) {
    return path.matches("^https?://.*") ? path : baseUrl.replaceAll("/$", "") + "/" + path.replaceFirst("^/", "");
  }

  public void goTo(String path) {
    driver.get(url(path));
  }

  public void click(Loc loc) {
    waitFor(() -> query(loc).stream().filter(e -> e.isDisplayed() && e.isEnabled()).findFirst().orElse(null), "No clickable element " + loc).click();
    answerDialog();
  }

  public void doubleClick(Loc loc) {
    new Actions(driver).doubleClick(el(loc)).perform();
  }

  public void rightClick(Loc loc) {
    new Actions(driver).contextClick(el(loc)).perform();
  }

  public void hover(Loc loc) {
    new Actions(driver).moveToElement(el(loc)).perform();
  }

  public void fill(Loc loc, String value) {
    WebElement e = el(loc);
    e.clear();
    if (!value.isEmpty()) e.sendKeys(value);
  }

  public void type(Loc loc, String value) {
    el(loc).sendKeys(value);
  }

  public void clear(Loc loc) {
    el(loc).clear();
  }

  public void setChecked(Loc loc, boolean checked) {
    WebElement e = el(loc);
    if (e.isSelected() != checked) e.click();
  }

  public void press(Loc loc, String key) {
    CharSequence keys = KEYS.getOrDefault(key, key);
    if (key.contains("+") && !KEYS.containsKey(key)) {
      String[] parts = key.split("\\+");
      Map<String, CharSequence> mods = Map.of("Control", Keys.CONTROL, "Meta", Keys.COMMAND, "Shift", Keys.SHIFT, "Alt", Keys.ALT);
      StringBuilder chord = new StringBuilder();
      for (int i = 0; i < parts.length - 1; i++) chord.append(mods.getOrDefault(parts[i], parts[i]));
      chord.append(KEYS.getOrDefault(parts[parts.length - 1], parts[parts.length - 1].toLowerCase()));
      keys = Keys.chord(chord);
    }
    (loc != null ? el(loc) : driver.switchTo().activeElement()).sendKeys(keys);
    answerDialog();
  }

  public void selectValue(Loc loc, String value) {
    new Select(el(loc)).selectByValue(value);
  }

  public void selectLabel(Loc loc, String label) {
    new Select(el(loc)).selectByVisibleText(label);
  }

  public void selectIndex(Loc loc, int index) {
    new Select(el(loc)).selectByIndex(index);
  }

  public void upload(Loc loc, String... files) {
    WebElement e = waitFor(() -> query(loc).stream().findFirst().orElse(null), "No element " + loc);
    e.sendKeys(String.join("\n", java.util.Arrays.stream(files).map(f -> Path.of(f).toAbsolutePath().toString()).toList()));
  }

  public void drag(Loc from, Loc to) {
    new Actions(driver).dragAndDrop(el(from), el(to)).perform();
  }

  public void scrollIntoView(Loc loc) {
    ((JavascriptExecutor) driver).executeScript("arguments[0].scrollIntoView({block: 'center'})", el(loc));
  }

  public void scroll(int x, int y) {
    ((JavascriptExecutor) driver).executeScript("window.scrollBy(arguments[0], arguments[1])", x, y);
  }

  public void screenshot(String name, Loc loc) throws Exception {
    Files.createDirectories(Path.of("screenshots"));
    byte[] png = loc != null ? el(loc).getScreenshotAs(OutputType.BYTES) : ((TakesScreenshot) driver).getScreenshotAs(OutputType.BYTES);
    Files.write(Path.of("screenshots", name + ".png"), png);
  }

  /** StepForge places this before the step that opens the dialog; it is answered after that step. */
  public void handleNextDialog(boolean accept, String promptText) {
    dialog = new Object[] {accept, promptText};
  }

  private void answerDialog() {
    if (dialog == null) return;
    long deadline = System.currentTimeMillis() + 2000;
    while (System.currentTimeMillis() < deadline) {
      try {
        Alert alert = driver.switchTo().alert();
        if (dialog[1] != null) alert.sendKeys((String) dialog[1]);
        if ((Boolean) dialog[0]) alert.accept();
        else alert.dismiss();
        dialog = null;
        return;
      } catch (NoAlertPresentException e) {
        try {
          Thread.sleep(100);
        } catch (InterruptedException ie) {
          Thread.currentThread().interrupt();
          return;
        }
      }
    }
  }

  public void frame(String css) {
    if (css == null) driver.switchTo().defaultContent();
    else driver.switchTo().frame(el(Loc.of("css", css)));
  }

  public void switchTab(Integer index, String urlContains) {
    String handle = waitFor(() -> {
      List<String> handles = List.copyOf(driver.getWindowHandles());
      if (index != null) return index < handles.size() ? handles.get(index) : null;
      if (urlContains != null) {
        for (String h : handles) {
          driver.switchTo().window(h);
          if (driver.getCurrentUrl().contains(urlContains)) return h;
        }
        return null;
      }
      return handles.size() > 1 ? handles.get(handles.size() - 1) : null;
    }, "No such tab");
    driver.switchTo().window(handle);
  }

  public void closeTab() {
    driver.close();
    List<String> handles = List.copyOf(driver.getWindowHandles());
    driver.switchTo().window(handles.get(handles.size() - 1));
  }

  public void waitFor(Loc loc, String state) {
    waitFor(() -> switch (state) {
      case "hidden" -> query(loc).stream().noneMatch(WebElement::isDisplayed);
      case "attached" -> !query(loc).isEmpty();
      case "detached" -> query(loc).isEmpty();
      default -> query(loc).stream().anyMatch(WebElement::isDisplayed);
    }, loc + " did not become " + state);
  }

  public void waitForUrl(String pattern) {
    String regex = pattern.replaceAll("[.+^${}()|\\[\\]\\\\]", "\\\\$0").replace("**", "\u0000").replace("*", "[^/]*").replace("\u0000", ".*");
    waitFor(() -> driver.getCurrentUrl().matches(regex) || driver.getCurrentUrl().contains(pattern), "URL never matched " + pattern);
  }

  public void waitForLoad() {
    waitFor(() -> "complete".equals(((JavascriptExecutor) driver).executeScript("return document.readyState")), "The page did not finish loading");
  }

  public Object read(String source, Loc loc, String attribute) {
    switch (source) {
      case "url": return driver.getCurrentUrl();
      case "title": return driver.getTitle();
      case "count": return query(loc).size();
      case "value": return el(loc).getDomProperty("value");
      case "attribute": return el(loc).getDomAttribute(attribute);
      default: return String.valueOf(el(loc).getDomProperty("textContent")).trim();
    }
  }

  private static String norm(String s) {
    return s == null ? "" : s.replaceAll("\\s+", " ").trim();
  }

  /** StepForge's UI checks, retried until they pass or the timeout ends. */
  public void expect(String check, Loc loc, Object expected, String attribute) {
    String want = expected == null ? null : Checks.text(expected);
    waitFor(() -> {
      if (check.startsWith("url")) {
        String actual = driver.getCurrentUrl();
        if (check.equals("url")) return actual.equals(url(want));
        return check.equals("urlContains") ? actual.contains(want) : Pattern.compile(want).matcher(actual).find();
      }
      if (check.startsWith("title")) return check.equals("title") ? driver.getTitle().equals(want) : driver.getTitle().contains(want);
      List<WebElement> all = query(loc);
      List<WebElement> shown = all.stream().filter(WebElement::isDisplayed).toList();
      if (check.equals("hidden")) return shown.isEmpty();
      if (check.equals("count")) return Checks.compare(all.size(), "equals", expected);
      if (shown.isEmpty()) return false;
      WebElement e = shown.get(0);
      String text = norm(e.getDomProperty("textContent"));
      return switch (check) {
        case "visible" -> true;
        case "text" -> text.equals(norm(want));
        case "textContains" -> text.contains(want);
        case "textMatches" -> Pattern.compile(want).matcher(text).find();
        case "value" -> want.equals(e.getDomProperty("value"));
        case "attribute" -> want.equals(e.getDomAttribute(attribute));
        case "enabled" -> e.isEnabled();
        case "disabled" -> !e.isEnabled();
        case "checked" -> e.isSelected();
        case "unchecked" -> !e.isSelected();
        default -> throw new IllegalArgumentException("Unknown check " + check);
      };
    }, "Expected " + (loc != null ? loc : "the page") + " " + check + (want != null ? " \"" + want + "\"" : ""));
  }

  public void expect(String check, Loc loc) {
    expect(check, loc, null, null);
  }
}
