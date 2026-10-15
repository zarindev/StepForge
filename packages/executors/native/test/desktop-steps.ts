import type { StepInput } from '@stepforge/core';

/** The same scenario for the desktop demo apps (CareClinic): sign in, add patients, menus, a shortcut, a dialog. */
export function desktopSteps(platform: 'macos' | 'windows' | 'linux'): StepInput[] {
  const id = (value: string) => [{ strategy: 'testId' as const, value }];
  const count = (expected: string) => ({
    type: 'ui.assert',
    params: { check: 'text', expected },
    locators: id('patient_count'),
  });
  return [
    { type: 'ui.fill', params: { value: 'nurse@careclinic.test' }, locators: id('email') },
    { type: 'ui.fill', params: { value: 'CareClinic1' }, locators: id('password') },
    { type: 'ui.click', locators: [{ strategy: 'role', value: 'button', name: 'Sign in' }] },
    count('No patients yet'),
    // The menu's keyboard shortcut puts the cursor in the name field (macOS and Windows).
    ...(platform === 'linux'
      ? []
      : [{ type: 'ui.press', params: { key: platform === 'macos' ? 'Meta+N' : 'Control+N' } }]),
    { type: 'ui.fill', params: { value: 'Ana Silva' }, locators: id('patient_name') },
    { type: 'ui.click', locators: id('add_patient') },
    count('1 patient'),
    { type: 'ui.menu', params: { path: 'Patients > Clear List' } },
    {
      type: 'ui.handleDialog',
      params: { action: 'accept', buttonLabel: platform === 'windows' ? 'Yes' : 'Clear' },
    },
    count('No patients yet'),
  ];
}
