import { describe, expect, it } from 'vitest';
import { elementAt, locatorsFor, parseElements } from '../src/index.ts';

const ANDROID = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy index="0" class="hierarchy" rotation="0" width="1080" height="2400">
  <android.widget.FrameLayout index="0" class="android.widget.FrameLayout" package="com.stepforge.careclinic" bounds="[0,0][1080,2400]">
    <android.widget.LinearLayout index="0" class="android.widget.LinearLayout" clickable="false" bounds="[0,0][1080,2400]">
      <android.widget.EditText index="0" class="android.widget.EditText" text="" hint="Email" resource-id="com.stepforge.careclinic:id/email" clickable="true" password="false" bounds="[63,197][1017,302]" />
      <android.widget.EditText index="1" class="android.widget.EditText" text="" hint="Password" resource-id="com.stepforge.careclinic:id/password" clickable="true" password="true" bounds="[63,302][1017,407]" />
      <android.widget.Button index="2" class="android.widget.Button" text="Sign in" resource-id="com.stepforge.careclinic:id/sign_in" clickable="true" bounds="[63,407][1017,551]" />
      <android.widget.TextView index="3" class="android.widget.TextView" text="Tom &amp; Jerry's" clickable="false" bounds="[63,551][1017,620]" />
    </android.widget.LinearLayout>
  </android.widget.FrameLayout>
</hierarchy>`;

const IOS = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="CareClinic" label="CareClinic" enabled="true" visible="true" x="0" y="0" width="402" height="874">
    <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="true" x="0" y="0" width="402" height="874">
      <XCUIElementTypeTextField type="XCUIElementTypeTextField" name="email" placeholderValue="Email" enabled="true" visible="true" x="24" y="140" width="354" height="34"/>
      <XCUIElementTypeSecureTextField type="XCUIElementTypeSecureTextField" name="password" placeholderValue="Password" enabled="true" visible="true" x="24" y="186" width="354" height="34"/>
      <XCUIElementTypeButton type="XCUIElementTypeButton" name="sign_in" label="Sign in" enabled="true" visible="true" x="24" y="232" width="354" height="30"/>
      <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="Welcome" label="Welcome" enabled="true" visible="true" x="24" y="280" width="354" height="20"/>
    </XCUIElementTypeOther>
  </XCUIElementTypeApplication>
</AppiumAUT>`;

describe('recording phone apps: the element under a tap and its locators', () => {
  it('Android: ids, hints, text and roles, from the element tree', () => {
    const els = parseElements(ANDROID);
    const button = elementAt(els, 500, 480)!;
    expect(button.attrs.text).toBe('Sign in');
    expect(locatorsFor(button)).toEqual([
      { strategy: 'testId', value: 'sign_in', score: 95 },
      { strategy: 'role', value: 'button', name: 'Sign in', score: 80 },
      { strategy: 'text', value: 'Sign in', score: 70 },
      {
        strategy: 'xpath',
        value: "//android.widget.Button[@resource-id='com.stepforge.careclinic:id/sign_in']",
        score: 30,
      },
    ]);
    const field = elementAt(els, 500, 250)!;
    expect(locatorsFor(field).slice(0, 2)).toEqual([
      { strategy: 'testId', value: 'email', score: 95 },
      { strategy: 'placeholder', value: 'Email', score: 85 },
    ]);
    // Entities are decoded; a text with quotes gets a safe XPath.
    const text = elementAt(els, 500, 600)!;
    expect(locatorsFor(text).at(-1)!.value).toBe(`//android.widget.TextView[@text="Tom & Jerry's"]`);
    expect(elementAt(els, 2000, 2000)).toBeUndefined();
  });

  it('iOS: accessibility ids, placeholders and labels; a label-only name is not an id', () => {
    const els = parseElements(IOS);
    expect(locatorsFor(elementAt(els, 100, 247)!).slice(0, 2)).toEqual([
      { strategy: 'testId', value: 'sign_in', score: 95 },
      { strategy: 'role', value: 'button', name: 'Sign in', score: 80 },
    ]);
    expect(locatorsFor(elementAt(els, 100, 200)!).slice(0, 2)).toEqual([
      { strategy: 'testId', value: 'password', score: 95 },
      { strategy: 'placeholder', value: 'Password', score: 85 },
    ]);
    // name === label: no identifier was set, so the text is the locator.
    expect(locatorsFor(elementAt(els, 100, 290)!)[0]).toEqual({
      strategy: 'role',
      value: 'text',
      name: 'Welcome',
      score: 80,
    });
  });
});
