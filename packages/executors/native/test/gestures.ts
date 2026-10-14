import type { StepInput } from '@stepforge/core';

/** The same gesture and device steps for the Android and iOS demo apps (CareClinic mobile). */
export function gestureSteps(platform: 'android' | 'ios'): StepInput[] {
  const id = (value: string) => [{ strategy: 'testId' as const, value }];
  const text = (value: string) => [{ strategy: 'text' as const, value }];
  const visible = (locators: StepInput['locators']) => ({
    type: 'ui.assert',
    params: { check: 'visible' },
    locators,
  });
  const count = (expected: string) => ({
    type: 'ui.assert',
    params: { check: 'text', expected },
    locators: id('patient_count'),
  });
  const add = (name: string): StepInput[] => [
    {
      type: 'ui.fill',
      params: { value: name },
      locators: [{ strategy: 'placeholder', value: 'Patient name' }],
    },
    { type: 'ui.click', locators: id('add_patient') },
  ];
  return [
    {
      type: 'ui.fill',
      params: { value: 'nurse@careclinic.test' },
      locators: [{ strategy: 'placeholder', value: 'Email' }],
    },
    { type: 'ui.hideKeyboard' },
    // The footer is far below the form.
    { type: 'ui.scrollTo', locators: text('support@careclinic.test') },
    visible(text('support@careclinic.test')),
    { type: 'ui.swipe', params: { direction: 'down' } },
    { type: 'ui.swipe', params: { direction: 'down' } },
    visible([{ strategy: 'placeholder', value: 'Password' }]),
    { type: 'ui.fill', params: { value: 'CareClinic1' }, locators: id('password') },
    { type: 'ui.click', locators: id('sign_in') },
    ...add('Ana Silva'),
    ...add('Ben Okafor'),
    count('2 patients'),
    // A long press removes a patient.
    { type: 'ui.longPress', locators: text('Ben Okafor') },
    count('1 patient'),
    { type: 'ui.rotate', params: { orientation: 'landscape' } },
    visible(id('patient_count')),
    { type: 'ui.rotate', params: { orientation: 'portrait' } },
    { type: 'ui.setLocation', params: { latitude: 51.5072, longitude: -0.1276 } },
    { type: 'ui.permission', params: { permission: 'location', action: 'grant' } },
    // In the background for two seconds, then back where it was.
    { type: 'ui.appState', params: { action: 'background', seconds: 2 } },
    visible(id('patient_count')),
    { type: 'ui.back' },
    visible([{ strategy: 'placeholder', value: 'Email' }]),
    { type: 'ui.deepLink', params: { url: 'careclinic://patients' } },
    visible(id('patient_count')),
    // A dialog: the app's own on Android, iOS's notification permission on iOS.
    { type: 'ui.click', locators: id('remind') },
    { type: 'ui.handleDialog', params: { action: 'accept' } },
    { type: 'ui.assert', params: { check: 'text', expected: 'Reminders on' }, locators: id('reminders') },
    ...(platform === 'ios'
      ? [{ type: 'ui.pushNotification', params: { title: 'Reminder', body: 'Ana Silva at 10:00' } }]
      : []),
    { type: 'ui.appState', params: { action: 'close' } },
    { type: 'ui.appState', params: { action: 'launch' } },
    visible([{ strategy: 'placeholder', value: 'Email' }]),
  ];
}
