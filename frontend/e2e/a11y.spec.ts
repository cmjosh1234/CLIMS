import { expect, test } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/axe';
import { resetMock } from './support/mock';
import { routesToVisit } from './support/routes';

/*
 * axe on every screen in the navigation table, plus sign-in and onboarding, as each first loads.
 * Serious and critical violations fail; the rest are attached to the report and printed.
 */

test.beforeEach(async ({ request }) => {
  await resetMock(request);
});

for (const route of routesToVisit()) {
  test(`${route.path} has no serious accessibility violations`, async ({ page }, testInfo) => {
    await page.goto(route.path);
    await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
    // Let the data settle: skeletons are replaced by the screen itself.
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
    await expectNoSeriousA11yViolations(page, testInfo, route.slug);
  });
}

// The profile belongs to no workspace, so the navigation table does not list it.
test('/profile has no serious accessibility violations', async ({ page }, testInfo) => {
  await page.goto('/profile');
  await expect(page.getByRole('heading', { level: 1, name: 'Your profile' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Personal details' })).toBeVisible();
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
  await expectNoSeriousA11yViolations(page, testInfo, 'profile');
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('/sign-in has no serious accessibility violations', async ({ page }, testInfo) => {
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await expectNoSeriousA11yViolations(page, testInfo, 'sign-in');
  });

  test('/onboarding has no serious accessibility violations', async ({ page }, testInfo) => {
    await page.goto('/onboarding?invite=demo-vht-2c7f9a41');
    await expect(page.getByLabel('Phone number')).toBeVisible();
    await expectNoSeriousA11yViolations(page, testInfo, 'onboarding');
  });
});
