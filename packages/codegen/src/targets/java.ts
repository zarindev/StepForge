import { CREDIT, ciFiles, day, envExample, headerLines, readme, runtime } from '../common.ts';
import type { El, Loc, Op, Plan, TestPlan } from '../ir.ts';
import { javaInt, javaBlock, javaJson, javaStr, javaText, javaVal } from '../lang/java.ts';
import type { CodegenOptions, GeneratedProject, TargetId } from '../types.ts';
import { camel, envName, parseString, pascal, snake, uniquer } from '../values.ts';

/** Java 17 + JUnit 5 + Maven: Selenium (with REST Assured for API steps), or REST Assured only. */
type Flavor = 'selenium' | 'api';

export function locatorJava(l: Loc): string {
  const v = (s: string) => javaText(parseString(s));
  const strategy = ['testId', 'role', 'label', 'placeholder', 'text', 'css', 'xpath'].includes(l.strategy)
    ? l.strategy
    : 'css';
  return `Loc.of(${javaStr(strategy)}, ${v(l.value)}${l.name ? `, ${v(l.name)}` : ''})`;
}

type State = {
  flavor: Flavor;
  lines: string[];
  n: Record<string, number>;
  lastApi?: string;
  lastDb?: string;
  lastMail?: string;
  pages: Set<string>;
  usesUi: boolean;
  plan: Plan;
  warn: (m: string) => void;
};

const next = (s: State, k: string) => `${k}${(s.n[k] = (s.n[k] ?? 0) + 1)}`;
const constName = (s: string) => snake(s).toUpperCase().replace(/^_/, '');

function el(s: State, e: El): string {
  if (e.pom) {
    s.pages.add(e.pom.page);
    return `${s.plan.pages.get(e.pom.page)!.className}.${constName(e.pom.name)}`;
  }
  return locatorJava(e.loc);
}

function uiOp(op: Op, s: State, out: (l: string) => void): boolean {
  const ui = [
    'goto',
    'act',
    'press',
    'select',
    'upload',
    'drag',
    'scroll',
    'waitFor',
    'waitUrl',
    'waitLoad',
    'assert',
    'read',
    'screenshot',
    'dialog',
    'frame',
    'tab',
    'closeTab',
  ];
  if (!ui.includes(op.op)) return false;
  if (s.flavor === 'api') {
    out(`// TODO(StepForge): browser step skipped (${op.op}); this export contains API tests only`);
    return true;
  }
  switch (op.op) {
    case 'goto':
      out(`browser.goTo(${javaText(op.url)});`);
      break;
    case 'act': {
      const l = el(s, op.el);
      const v = op.value ? javaText(op.value) : '""';
      out(
        {
          click: `browser.click(${l});`,
          dblclick: `browser.doubleClick(${l});`,
          rightclick: `browser.rightClick(${l});`,
          hover: `browser.hover(${l});`,
          clear: `browser.clear(${l});`,
          check: `browser.setChecked(${l}, true);`,
          uncheck: `browser.setChecked(${l}, false);`,
          scrollIntoView: `browser.scrollIntoView(${l});`,
          fill: `browser.fill(${l}, ${v});`,
          type: `browser.type(${l}, ${v});`,
        }[op.action],
      );
      break;
    }
    case 'press':
      out(`browser.press(${op.el ? el(s, op.el) : 'null'}, ${javaStr(op.key)});`);
      break;
    case 'select':
      out(
        op.by === 'index'
          ? `browser.selectIndex(${el(s, op.el)}, ${javaInt(op.value)});`
          : op.by === 'label'
            ? `browser.selectLabel(${el(s, op.el)}, ${javaText(op.value)});`
            : `browser.selectValue(${el(s, op.el)}, ${javaText(op.value)});`,
      );
      break;
    case 'upload':
      out(`browser.upload(${el(s, op.el)}, ${op.files.map(javaText).join(', ')});`);
      break;
    case 'drag':
      s.warn('HTML5 drag and drop is unreliable in Selenium; check this step');
      out(`browser.drag(${el(s, op.el)}, ${el(s, op.to)});`);
      break;
    case 'scroll':
      out(`browser.scroll(${op.x}, ${op.y});`);
      break;
    case 'waitFor':
      out(`browser.waitFor(${el(s, op.el)}, ${javaStr(op.state)});`);
      break;
    case 'waitUrl':
      out(`browser.waitForUrl(${javaText(op.url)});`);
      break;
    case 'waitLoad':
      out('browser.waitForLoad();');
      break;
    case 'assert':
      out(
        `browser.expect(${javaStr(op.check)}, ${op.el ? el(s, op.el) : 'null'}, ${op.expected ? javaVal(op.expected) : 'null'}, ${op.attribute ? javaStr(op.attribute) : 'null'});`,
      );
      break;
    case 'read': {
      const value = `browser.read(${javaStr(op.source)}, ${op.el ? el(s, op.el) : 'null'}, ${op.attribute ? javaStr(op.attribute) : 'null'})`;
      out(`vars.put(${javaStr(op.into)}, ${op.regex ? `capture(${value}, ${javaStr(op.regex)})` : value});`);
      break;
    }
    case 'screenshot':
      out(`browser.screenshot(${javaStr(op.name)}, ${op.el ? el(s, op.el) : 'null'});`);
      break;
    case 'dialog':
      out(`browser.handleNextDialog(${op.accept}, ${op.promptText ? javaText(op.promptText) : 'null'});`);
      break;
    case 'frame':
      out(`browser.frame(${op.selector === null ? 'null' : javaStr(op.selector)});`);
      break;
    case 'tab':
      out(
        `browser.switchTab(${op.index !== undefined ? op.index : 'null'}, ${op.urlContains !== undefined ? javaStr(op.urlContains) : 'null'});`,
      );
      break;
    case 'closeTab':
      out('browser.closeTab();');
      break;
  }
  return true;
}

function printOps(ops: Op[], s: State, ind: string): void {
  const out = (line: string) => s.lines.push(`${ind}${line}`);
  for (const op of ops) {
    if (uiOp(op, s, out)) continue;
    switch (op.op) {
      case 'comment':
        out(`// ${op.text}`);
        break;
      case 'todo':
        out(`// TODO(StepForge): ${op.text}`);
        break;
      case 'api': {
        const r = next(s, 'res');
        const chain: string[] = ['given()', '.filter(cookies)'];
        for (const [k, v] of op.headers) chain.push(`.header(${javaStr(k)}, ${javaText(v)})`);
        for (const [k, v] of op.query) chain.push(`.queryParam(${javaStr(k)}, ${javaVal(v)})`);
        if (op.auth?.type === 'bearer')
          chain.push(`.header("Authorization", "Bearer " + ${javaText(op.auth.token)})`);
        if (op.auth?.type === 'basic')
          chain.push(
            `.auth().preemptive().basic(${javaText(op.auth.username)}, ${javaText(op.auth.password)})`,
          );
        if (op.auth?.type === 'apiKey')
          chain.push(
            op.auth.in === 'query'
              ? `.queryParam(${javaStr(op.auth.name)}, ${javaText(op.auth.value)})`
              : `.header(${javaStr(op.auth.name)}, ${javaText(op.auth.value)})`,
          );
        if (op.auth?.type === 'cookie')
          chain.push(`.cookie(${javaStr(op.auth.name)}, ${javaText(op.auth.value)})`);
        if (op.body && op.bodyType !== 'none') {
          if (op.bodyType === 'form')
            chain.push('.contentType(ContentType.URLENC)', `.formParams(${javaVal(op.body)})`);
          else if (op.bodyType === 'raw') chain.push(`.body(${javaText(op.body)})`);
          else if (op.bodyType === 'multipart') {
            s.warn(
              'multipart bodies need .multiPart(...) per field in REST Assured; sent as form fields here',
            );
            chain.push('.contentType(ContentType.MULTIPART)', `.formParams(${javaVal(op.body)})`);
          } else chain.push('.contentType(ContentType.JSON)', `.body(${javaVal(op.body)})`);
        }
        chain.push('.when()', `.request(${javaStr(op.method)}, ${javaText(op.url)})`);
        out(`Api.Result ${r} = Api.result(`);
        out(`    ${chain[0]}`);
        for (const c of chain.slice(1)) out(`        ${c}`);
        out(');');
        for (const a of op.asserts) {
          if (a.target === 'status' && a.operator === 'equals')
            out(`assertEquals(${javaVal(a.expected)}, ${r}.status(), "status");`);
          else
            out(
              `check(pick(${r}, ${javaStr(a.target)}), ${javaStr(a.operator)}, ${javaVal(a.expected)}, ${javaStr(`${a.target} ${a.operator}`)});`,
            );
        }
        if (op.into) out(`vars.put(${javaStr(op.into)}, ${r}.body());`);
        s.lastApi = r;
        break;
      }
      case 'apiExtract': {
        const target =
          op.from === 'status'
            ? 'status'
            : op.from === 'header'
              ? `header:${op.name ?? ''}`
              : (op.path ?? 'body');
        out(
          s.lastApi
            ? `vars.put(${javaStr(op.into)}, pick(${s.lastApi}, ${javaStr(target)}));`
            : '// TODO(StepForge): api.extract without an earlier request',
        );
        break;
      }
      case 'setVar':
        out(`vars.put(${javaStr(op.name)}, ${javaVal(op.value)});`);
        break;
      case 'gen':
        out(
          `vars.put(${javaStr(op.into)}, Fake.data(${javaStr(op.kind)}${Object.keys(op.opts).length ? `, ${javaJson(op.opts)}` : ''}));`,
        );
        break;
      case 'wait':
        out(`Thread.sleep(${op.ms});`);
        break;
      case 'log':
        out(`System.out.println(${javaText(op.message)});`);
        break;
      case 'script':
        s.warn('JavaScript "Run script" steps are not translated to Java');
        out('// TODO(StepForge): this JavaScript step was not translated to Java:');
        for (const l of op.code.split('\n')) out(`//   ${l}`);
        break;
      case 'if':
        out(`if (compare(${javaVal(op.value)}, ${javaStr(op.operator)}, ${javaVal(op.expected)})) {`);
        printOps(op.then, s, `${ind}  `);
        if (op.else.length) {
          out('} else {');
          printOps(op.else, s, `${ind}  `);
        }
        out('}');
        break;
      case 'loop':
        if (op.over) {
          out('{');
          out('  int index = 0;');
          out(`  for (Object item : J.items(${javaVal(op.over)})) {`);
          out(`    vars.put(${javaStr(op.as)}, item);`);
          out('    vars.put("index", index++);');
          printOps(op.body, s, `${ind}    `);
          out('  }');
          out('}');
        } else {
          out(`for (int index = 0; index < ${javaInt(op.count!)}; index++) {`);
          out('  vars.put("index", index);');
          printOps(op.body, s, `${ind}  `);
          out('}');
        }
        break;
      case 'check':
        out(
          `check(${javaVal(op.actual)}, ${javaStr(op.operator)}, ${javaVal(op.expected)}, ${javaStr(op.message)});`,
        );
        break;
      case 'db': {
        const r = next(s, 'db');
        out(`// SQL also in ${op.sqlFile}`);
        out(
          op.kind === 'script'
            ? `Db.Result ${r} = Db.script(${javaStr(op.connection)}, ${javaBlock(op.sql)});`
            : `Db.Result ${r} = Db.query(${javaStr(op.connection)}, ${javaBlock(op.sql)}${op.params.length ? `, J.list(${op.params.map(javaVal).join(', ')})` : ''});`,
        );
        for (const a of op.asserts)
          out(
            `check(pick(${r}, ${javaStr(a.target)}), ${javaStr(a.operator)}, ${javaVal(a.expected)}, ${javaStr(`${a.target} ${a.operator}`)});`,
          );
        if (op.into) out(`vars.put(${javaStr(op.into)}, ${r}.rows());`);
        s.lastDb = r;
        break;
      }
      case 'dbExtract':
        out(
          s.lastDb
            ? `vars.put(${javaStr(op.into)}, pick(${s.lastDb}, ${javaStr(op.path)}));`
            : '// TODO(StepForge): db.extract without an earlier query',
        );
        break;
      case 'emailWait': {
        const m = next(s, 'email');
        const crit = (['to', 'from', 'subject', 'contains'] as const).flatMap((k) =>
          op[k] ? [`${javaStr(k)}, ${javaText(op[k]!)}`] : [],
        );
        out(
          `Map<String, Object> ${m} = Mail.waitForEmail(testStart, J.map(${crit.join(', ')}), ${op.timeoutMs});`,
        );
        if (op.into) out(`vars.put(${javaStr(op.into)}, ${m});`);
        s.lastMail = m;
        break;
      }
      case 'emailAssert':
        out(
          s.lastMail
            ? `Mail.assertEmail(${s.lastMail}, J.map(${op.checks.map((c) => `${javaStr(c.kind)}, ${c.value.t === 'bool' ? String(c.value.v) : javaText(c.value)}`).join(', ')}));`
            : '// TODO(StepForge): email check without an earlier wait for email',
        );
        break;
      case 'emailExtract': {
        if (!s.lastMail) {
          out('// TODO(StepForge): email extraction without an earlier wait for email');
          break;
        }
        const call =
          op.kind === 'otp'
            ? `Mail.otp(${s.lastMail})`
            : op.kind === 'link'
              ? `Mail.link(${s.lastMail}, ${op.contains ? javaText(op.contains) : 'null'}, ${op.index ?? 0})`
              : `Mail.extract(${s.lastMail}, ${javaStr(op.pattern ?? '(.+)')})`;
        out(`vars.put(${javaStr(op.into)}, ${call});`);
        break;
      }
      case 'emailOpenLink': {
        const url = op.url
          ? javaText(op.url)
          : s.lastMail
            ? `Mail.link(${s.lastMail}, ${op.contains ? javaText(op.contains) : 'null'}, ${op.index ?? 0})`
            : '""';
        if (s.usesUi && s.flavor === 'selenium') out(`browser.goTo(${url});`);
        else {
          const r = next(s, 'res');
          out(`Api.Result ${r} = Api.result(given().filter(cookies).when().get(${url}));`);
          s.lastApi = r;
        }
        break;
      }
      default:
        break;
    }
  }
}

const javaPackage = (path: string[]) =>
  ['tests', ...path.map((p) => snake(p).replace(/^_/, 'm') || 'module')].join('.');

function testClass(
  plan: Plan,
  t: TestPlan,
  flavor: Flavor,
  className: string,
  warn: (m: string) => void,
): string {
  const s: State = { flavor, lines: [], n: {}, pages: new Set(), usesUi: t.usesUi, plan, warn };
  printOps(t.ops, s, '    ');
  const code = s.lines.join('\n').replace(/\/\/.*$/gm, '');
  const browser = flavor === 'selenium' && t.usesUi;
  const cases = t.scenario.testCases;
  const method = camel(t.scenario.name, 'scenario');
  const tags = [...t.scenario.tags.map((x) => snake(x)), t.scenario.priority.toLowerCase()];
  const usesData = /\bdata\.get\(|\(data,/.test(code);
  const imports = [
    ...(/\bassertEquals\(/.test(code)
      ? ['import static org.junit.jupiter.api.Assertions.assertEquals;']
      : []),
    ...(/\bgiven\(\)/.test(code) ? ['import static io.restassured.RestAssured.given;'] : []),
    ...['capture', 'check', 'compare', 'field', 'pick', 'text']
      .filter((h) => new RegExp(`\\b${h}\\(`).test(code))
      .map((h) => `import static support.Checks.${h};`),
    '',
    ...(/ContentType\./.test(code) ? ['import io.restassured.http.ContentType;'] : []),
    'import java.util.HashMap;',
    'import java.util.Map;',
    ...(/\btestStart\b/.test(code) ? ['import java.time.Instant;'] : []),
    ...(cases.length ? ['import java.util.stream.Stream;'] : []),
    ...(cases.length
      ? [
          'import org.junit.jupiter.params.ParameterizedTest;',
          'import org.junit.jupiter.params.provider.Arguments;',
          'import org.junit.jupiter.params.provider.MethodSource;',
        ]
      : ['import org.junit.jupiter.api.Test;']),
    'import org.junit.jupiter.api.DisplayName;',
    'import org.junit.jupiter.api.Tag;',
    ...(/\bApi\./.test(code) ? ['import support.Api;'] : []),
    ...(browser ? ['import support.BrowserTest;'] : ['import support.ApiTest;']),
    ...(/\bLoc\./.test(code) ? ['import support.Browser.Loc;'] : []),
    ...(/\bConfig\./.test(code) ? ['import support.Config;'] : []),
    ...(/\bDb\./.test(code) ? ['import support.Db;'] : []),
    ...(/\bFake\./.test(code) ? ['import support.Fake;'] : []),
    ...(/\bJ\./.test(code) || cases.length ? ['import support.J;'] : []),
    ...(/\bMail\./.test(code) ? ['import support.Mail;'] : []),
    ...[...s.pages].map((p) => `import pages.${plan.pages.get(p)!.className};`),
  ];
  const body = [
    ...(/\btestStart\b/.test(code) ? ['    Instant testStart = Instant.now();'] : []),
    '    Map<String, Object> vars = new HashMap<>();',
    ...s.lines,
  ];
  return [
    ...headerLines(plan.input, t.scenario).map((l) => `// ${l}`),
    `package ${javaPackage(t.scenario.modulePath)};`,
    '',
    ...imports,
    '',
    ...tags.map((x) => `@Tag(${javaStr(x)})`),
    `@DisplayName(${javaStr([...t.scenario.modulePath, t.scenario.name].join(' › '))})`,
    `class ${className} extends ${browser ? 'BrowserTest' : 'ApiTest'} {`,
    ...(cases.length
      ? [
          '  static Stream<Arguments> testCases() {',
          '    return Stream.of(',
          cases
            .map(
              (c) => `        Arguments.of(${javaStr(`${c.code} ${c.title}`.trim())}, ${javaJson(c.data)})`,
            )
            .join(',\n'),
          '    );',
          '  }',
          '',
          '  @ParameterizedTest(name = "{0}")',
          '  @MethodSource("testCases")',
          `  void ${method}(String testCase, Map<String, Object> data) throws Exception {`,
        ]
      : [
          '  @Test',
          `  @DisplayName(${javaStr(t.scenario.name)})`,
          `  void ${method}() throws Exception {`,
          ...(usesData ? ['    Map<String, Object> data = new HashMap<>();'] : []),
        ]),
    ...body,
    '  }',
    '}',
    '',
  ].join('\n');
}

function pom(plan: Plan, flavor: Flavor): string {
  const engines = new Set(plan.tests.flatMap((t) => t.ops.flatMap((x) => (x.op === 'db' ? [x.engine] : []))));
  const any = engines.has('any');
  const dep = (g: string, a: string, v: string, scope = 'test') =>
    `    <dependency>\n      <groupId>${g}</groupId>\n      <artifactId>${a}</artifactId>\n      <version>${v}</version>\n      <scope>${scope}</scope>\n    </dependency>`;
  const slug = snake(plan.input.application.slug || plan.input.application.name).replace(/_/g, '-');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!-- ${CREDIT} -->`,
    '<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">',
    '  <modelVersion>4.0.0</modelVersion>',
    '  <groupId>tests</groupId>',
    `  <artifactId>${slug}-${flavor === 'selenium' ? 'selenium' : 'api'}-tests</artifactId>`,
    '  <version>1.0.0</version>',
    `  <name>${plan.input.application.name} tests</name>`,
    '  <properties>',
    '    <maven.compiler.release>17</maven.compiler.release>',
    '    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>',
    '  </properties>',
    '  <dependencies>',
    dep('org.junit.jupiter', 'junit-jupiter', '5.11.4'),
    dep('io.rest-assured', 'rest-assured', '5.5.0'),
    dep('com.fasterxml.jackson.core', 'jackson-databind', '2.18.2'),
    dep('net.datafaker', 'datafaker', '2.4.2'),
    dep('io.github.cdimascio', 'dotenv-java', '3.1.0'),
    ...(flavor === 'selenium' ? [dep('org.seleniumhq.selenium', 'selenium-java', '4.27.0')] : []),
    ...(any || engines.has('pg') ? [dep('org.postgresql', 'postgresql', '42.7.4')] : []),
    ...(any || engines.has('mysql') ? [dep('com.mysql', 'mysql-connector-j', '9.1.0')] : []),
    ...(any || engines.has('sqlite') ? [dep('org.xerial', 'sqlite-jdbc', '3.47.1.0')] : []),
    '  </dependencies>',
    '  <build>',
    '    <plugins>',
    '      <plugin>',
    '        <groupId>org.apache.maven.plugins</groupId>',
    '        <artifactId>maven-surefire-plugin</artifactId>',
    '        <version>3.5.2</version>',
    '      </plugin>',
    '    </plugins>',
    '  </build>',
    '</project>',
    '',
  ].join('\n');
}

function configJava(plan: Plan): string {
  return [
    'package support;',
    '',
    'import io.github.cdimascio.dotenv.Dotenv;',
    'import java.util.Map;',
    '',
    `/** ${CREDIT}. Environment variables (from .env or the environment); defaults come from the exported environment. */`,
    'public final class Config {',
    '  private static final Dotenv ENV = Dotenv.configure().ignoreIfMissing().load();',
    '  private static final Map<String, String> DEFAULTS = Map.ofEntries(',
    [
      `      Map.entry("BASE_URL", ${javaStr(plan.input.environment.baseUrl)})`,
      ...plan.variables.map(
        (v) =>
          `      Map.entry(${javaStr(envName(v))}, ${javaStr(plan.input.environment.variables[v] ?? '')})`,
      ),
    ].join(',\n'),
    '  );',
    '',
    "  /** A unique id for this test run, like StepForge's {{run.id}}. */",
    '  public static final String RUN_ID = Long.toHexString(System.currentTimeMillis()) + (int) (Math.random() * 10000);',
    '',
    '  private Config() {}',
    '',
    '  public static String get(String key) {',
    '    String v = ENV.get(key);',
    '    return v != null && !v.isEmpty() ? v : DEFAULTS.get(key);',
    '  }',
    '',
    '  public static String baseUrl() {',
    '    return get("BASE_URL");',
    '  }',
    '',
    '  /** {{env.name}}: the variable NAME in upper snake case. */',
    '  public static String env(String name) {',
    '    return get(name.replaceAll("([a-z0-9])([A-Z])", "$1_$2").replaceAll("[^A-Za-z0-9]+", "_").toUpperCase());',
    '  }',
    '',
    '  /** A secret from the environment (.env locally, CI secrets in pipelines). Never stored in the code. */',
    '  public static String secret(String name) {',
    '    String v = get(name);',
    '    if (v == null || v.isEmpty()) throw new IllegalStateException("Set the " + name + " environment variable (see .env.example)");',
    '    return v;',
    '  }',
    '}',
    '',
  ].join('\n');
}

const BASES = (flavor: Flavor) => ({
  'src/test/java/support/ApiTest.java': [
    'package support;',
    '',
    'import io.restassured.RestAssured;',
    'import io.restassured.filter.cookie.CookieFilter;',
    'import org.junit.jupiter.api.BeforeAll;',
    '',
    `/** ${CREDIT}. Base class: REST Assured points at BASE_URL; cookies are kept between the requests of a test. */`,
    'public abstract class ApiTest {',
    '  protected final CookieFilter cookies = new CookieFilter();',
    '',
    '  @BeforeAll',
    '  static void configureRestAssured() {',
    '    RestAssured.baseURI = Config.baseUrl();',
    '    RestAssured.enableLoggingOfRequestAndResponseIfValidationFails();',
    '  }',
    '}',
    '',
  ].join('\n'),
  ...(flavor === 'selenium' && {
    'src/test/java/support/BrowserTest.java': [
      'package support;',
      '',
      'import org.junit.jupiter.api.AfterEach;',
      'import org.junit.jupiter.api.BeforeEach;',
      'import org.openqa.selenium.chrome.ChromeDriver;',
      'import org.openqa.selenium.chrome.ChromeOptions;',
      '',
      `/** ${CREDIT}. Base class for browser tests: Chrome (headless unless HEADED=1); Selenium Manager gets the driver. */`,
      'public abstract class BrowserTest extends ApiTest {',
      '  protected Browser browser;',
      '',
      '  @BeforeEach',
      '  void openBrowser() {',
      '    ChromeOptions options = new ChromeOptions();',
      '    if (!"1".equals(Config.get("HEADED"))) options.addArguments("--headless=new");',
      '    options.addArguments("--window-size=1440,900");',
      '    browser = new Browser(new ChromeDriver(options), Config.baseUrl());',
      '  }',
      '',
      '  @AfterEach',
      '  void closeBrowser() {',
      '    if (browser != null) browser.driver().quit();',
      '  }',
      '}',
      '',
    ].join('\n'),
  }),
});

export function generateJava(
  plan: Plan,
  o: CodegenOptions,
  flavor: Flavor,
  target: TargetId,
): GeneratedProject {
  const files: Record<string, string> = {};
  const warnings = [...plan.warnings];
  const tests = flavor === 'api' ? plan.tests.filter((t) => t.usesApi || !t.usesUi) : plan.tests;
  for (const t of plan.tests)
    if (!tests.includes(t))
      warnings.push({
        scenario: t.scenario.name,
        message: 'skipped: it has browser steps and this export contains API tests only',
      });
  const classNames = uniquer();
  for (const t of tests) {
    const pkg = javaPackage(t.scenario.modulePath);
    const cls = classNames(`${pascal(t.scenario.name, 'Scenario')}Test`);
    files[`src/test/java/${pkg.replace(/\./g, '/')}/${cls}.java`] = testClass(
      plan,
      t,
      flavor,
      cls,
      (message) => warnings.push({ scenario: t.scenario.name, message }),
    );
  }
  const all = Object.values(files).join('\n');
  files['pom.xml'] = pom(plan, flavor);
  files['src/test/java/support/Config.java'] = configJava(plan);
  Object.assign(files, BASES(flavor));
  for (const f of ['Checks', 'J', 'Api', 'Fake', 'Db'] as const)
    files[`src/test/java/support/${f}.java`] = runtime(`java/${f}.java`);
  if (/\bMail\./.test(all)) files['src/test/java/support/Mail.java'] = runtime('java/Mail.java');
  if (flavor === 'selenium') {
    files['src/test/java/support/Browser.java'] = runtime('java/Browser.java');
    files['src/test/resources/find.js'] = runtime('selenium/find.js');
    for (const p of plan.pages.values())
      files[`src/test/java/pages/${p.className}.java`] = [
        'package pages;',
        '',
        'import support.Browser.Loc;',
        '',
        `/** ${CREDIT}. Page object: one locator per element. */`,
        `public final class ${p.className} {`,
        ...p.elements.map((e) => `  public static final Loc ${constName(e.name)} = ${locatorJava(e.loc)};`),
        '',
        `  private ${p.className}() {}`,
        '}',
        '',
      ].join('\n');
  }
  Object.assign(files, plan.sqlFiles);
  Object.assign(files, ciFiles(plan, 'java', o.ci));
  files['.env.example'] = envExample(plan);
  files['.gitignore'] = ['target/', '.env', 'screenshots/', ''].join('\n');
  files['README.md'] = readme(
    { ...plan, warnings },
    {
      title:
        flavor === 'selenium'
          ? 'Selenium tests (Java + JUnit 5)'
          : 'API tests (Java + REST Assured + JUnit 5)',
      install: ['# Java 17+ and Maven 3.9+'],
      run: [
        'mvn test                      # all tests (reports in target/surefire-reports)',
        'mvn test -Dgroups=smoke       # one tag',
        ...(flavor === 'selenium' ? ['HEADED=1 mvn test             # watch the browser'] : []),
      ],
      layout: [
        '`src/test/java/tests/` — one class per scenario, packages per module; test cases are parameterised',
        ...(plan.pages.size && flavor === 'selenium'
          ? ['`src/test/java/pages/` — page objects (one locator per element)']
          : []),
        '`src/test/java/support/` — configuration, REST Assured base class, helpers',
        ...(Object.keys(plan.sqlFiles).length ? ['`sql/` — the SQL of each database step'] : []),
      ],
      notes: [
        ...(flavor === 'selenium'
          ? [
              'Elements are found by role, label, text and test id like in StepForge (src/test/resources/find.js); every lookup and check waits up to 10 s.',
            ]
          : []),
        `Exported on ${day(plan.input)}; re-export from StepForge after changing the scenarios.`,
      ],
    },
  );
  return { target, files, warnings, run: 'mvn test' };
}
